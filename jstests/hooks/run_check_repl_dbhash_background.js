/**
 * Runs the dbHash command across all members of a replica set and compares the output.
 *
 * Unlike run_check_repl_dbhash.js, this version of the hook doesn't require that all operations
 * have finished replicating, nor does it require that the test has finished running. The dbHash
 * command reads at a particular clusterTime in order for an identical snapshot to be used by all
 * members of the replica set.
 *
 * The find and getMore commands used to generate the collection diff read at the same clusterTime
 * as the dbHash command. While this ensures the diagnostics for a dbhash mismatch aren't subjected
 * to changes from any operations in flight, it is possible for the collection or an index on the
 * collection to be dropped due to no locks being held.
 *
 * If a transient error occurs, then the dbhash check is retried until it succeeds, or until it
 * fails with a non-transient error. The most common case of a transient error is attempting to read
 * from a collection after a catalog operation has been performed on the collection or database.
 */
'use strict';

(function() {
load('jstests/libs/discover_topology.js');  // For Topology and DiscoverTopology.
load('jstests/libs/parallelTester.js');     // For ScopedThread.

if (typeof db === 'undefined') {
    throw new Error(
        "Expected mongo shell to be connected a server, but global 'db' object isn't defined");
}

// We turn off printing the JavaScript stacktrace in doassert() to avoid generating an
// overwhelming amount of log messages when handling transient errors.
TestData = TestData || {};
TestData.traceExceptions = false;

const conn = db.getMongo();
const topology = DiscoverTopology.findConnectedNodes(conn);

function checkReplDbhashBackgroundThread(hosts) {
    let debugInfo = [];

    // Calls 'func' with the print() function overridden to be a no-op.
    const quietly = (func) => {
        const printOriginal = print;
        try {
            print = Function.prototype;
            func();
        } finally {
            print = printOriginal;
        }
    };

    let rst;
    // We construct the ReplSetTest instance with the print() function overridden to be a no-op
    // in order to suppress the log messages about the replica set configuration. The
    // run_check_repl_dbhash_background.js hook is executed frequently by resmoke.py and would
    // otherwise lead to generating an overwhelming amount of log messages.
    quietly(() => {
        rst = new ReplSetTest(hosts[0]);
    });

    if (!rst.getPrimary().adminCommand("serverStatus").storageEngine.supportsSnapshotReadConcern) {
        print("Skipping data consistency checks for replica set: " + rst.getURL() +
              " because storage engine does not support snapshot reads.");
        return {ok: 1};
    }
    print("Running data consistency checks for replica set: " + rst.getURL());

    const sessions = [
        rst.getPrimary(),
        ...rst.getSecondaries().filter(conn => {
            return !conn.adminCommand({isMaster: 1}).arbiterOnly;
        })
    ].map(conn => conn.startSession({causalConsistency: false}));

    const resetFns = [];
    const kForeverSeconds = 1e9;
    const dbNames = new Set();

    // We enable the "WTPreserveSnapshotHistoryIndefinitely" failpoint to ensure that the same
    // snapshot will be available to read at on the primary and secondaries.
    for (let session of sessions) {
        const db = session.getDatabase('admin');

        let preserveRes = assert.commandWorked(db.runCommand({
            configureFailPoint: 'WTPreserveSnapshotHistoryIndefinitely',
            mode: 'alwaysOn',
        }),
                                               debugInfo);
        debugInfo.push({
            "node": db.getMongo(),
            "session": session,
            "preserveFailPointOpTime": preserveRes['operationTime']
        });

        resetFns.push(() => {
            assert.commandWorked(db.runCommand({
                configureFailPoint: 'WTPreserveSnapshotHistoryIndefinitely',
                mode: 'off',
            }));
        });
    }

    for (let session of sessions) {
        const db = session.getDatabase('admin');
        const res = assert.commandWorked(db.runCommand({listDatabases: 1, nameOnly: true}));
        for (let dbInfo of res.databases) {
            dbNames.add(dbInfo.name);
        }
        debugInfo.push({
            "node": db.getMongo(),
            "session": session,
            "listDatabaseOpTime": res['operationTime']
        });
    }

    // Transactions cannot be run on the following databases so we don't attempt to read at a
    // clusterTime on them either. (The "local" database is also not replicated.)
    dbNames.delete('admin');
    dbNames.delete('config');
    dbNames.delete('local');

    const results = [];

    // The waitForSecondaries() function waits for all secondaries to have applied up to
    // 'clusterTime' locally. This ensures that a later $_internalReadAtClusterTime read doesn't
    // fail as a result of the secondary's clusterTime being behind 'clusterTime'.
    const waitForSecondaries = (clusterTime, signedClusterTime) => {
        debugInfo.push({"waitForSecondaries": clusterTime, "signedClusterTime": signedClusterTime});
        for (let i = 1; i < sessions.length; ++i) {
            const session = sessions[i];
            const db = session.getDatabase('admin');

            // We advance the clusterTime on the secondary's session to ensure that
            // 'clusterTime' doesn't exceed the node's notion of the latest clusterTime.
            session.advanceClusterTime(signedClusterTime);

            // We need to make sure the secondary has applied up to 'clusterTime' and advanced
            // its majority commit point.

            if (jsTest.options().enableMajorityReadConcern !== false) {
                // If majority reads are supported, we can issue an afterClusterTime read on
                // a nonexistent collection and wait on it. This has the advantage of being
                // easier to debug in case of a timeout.
                let res = assert.commandWorked(db.runCommand({
                    find: 'run_check_repl_dbhash_background',
                    readConcern: {level: 'majority', afterClusterTime: clusterTime},
                    limit: 1,
                    singleBatch: true,
                }),
                                               debugInfo);
                debugInfo.push({
                    "node": db.getMongo(),
                    "session": session,
                    "majorityReadOpTime": res['operationTime']
                });
            } else {
                // If majority reads are not supported, then our only option is to poll for the
                // appliedOpTime on the secondary to catch up.
                assert.soon(
                    function() {
                        const rsStatus =
                            assert.commandWorked(db.adminCommand({replSetGetStatus: 1}));

                        // The 'atClusterTime' waits for the appliedOpTime to advance to
                        // 'clusterTime'.
                        const appliedOpTime = rsStatus.optimes.appliedOpTime;
                        if (bsonWoCompare(appliedOpTime.ts, clusterTime) >= 0) {
                            debugInfo.push({
                                "node": db.getMongo(),
                                "session": session,
                                "appliedOpTime": appliedOpTime.ts
                            });
                        }

                        return bsonWoCompare(appliedOpTime.ts, clusterTime) >= 0;
                    },
                    "The majority commit point on secondary " + i + " failed to reach " +
                        clusterTime,
                    10 * 60 * 1000);
            }
        }
    };

    // The checkCollectionHashesForDB() function identifies a collection by its UUID and ignores
    // the case where a collection isn't present on a node to work around how the collection
    // catalog isn't multi-versioned. Unlike with ReplSetTest#checkReplicatedDataHashes(), it is
    // possible for a collection catalog operation (e.g. a drop or rename) to have been applied
    // on the primary but not yet applied on the secondary.
    const checkCollectionHashesForDB = (dbName, clusterTime) => {
        const result = [];
        const hashes =
            rst.getHashesUsingSessions(sessions, dbName, {readAtClusterTime: clusterTime});
        const hashesByUUID = hashes.map((response, i) => {
            const info = {};

            for (let collName of Object.keys(response.collections)) {
                const hash = response.collections[collName];
                const uuid = response.uuids[collName];
                if (uuid !== undefined) {
                    info[uuid.toString()] = {
                        host: sessions[i].getClient().host,
                        hash,
                        collName,
                        uuid,
                    };
                }
            }

            return Object.assign({}, response, {hashesByUUID: info});
        });

        const primarySession = sessions[0];
        for (let i = 1; i < hashes.length; ++i) {
            const uuids = new Set([
                ...Object.keys(hashesByUUID[0].hashesByUUID),
                ...Object.keys(hashesByUUID[i].hashesByUUID),
            ]);

            const secondarySession = sessions[i];
            for (let uuid of uuids) {
                const primaryInfo = hashesByUUID[0].hashesByUUID[uuid];
                const secondaryInfo = hashesByUUID[i].hashesByUUID[uuid];

                if (primaryInfo === undefined) {
                    print("Skipping collection because it doesn't exist on the primary: " +
                          tojsononeline(secondaryInfo));
                    continue;
                }

                if (secondaryInfo === undefined) {
                    print("Skipping collection because it doesn't exist on the secondary: " +
                          tojsononeline(primaryInfo));
                    continue;
                }

                if (primaryInfo.hash !== secondaryInfo.hash) {
                    print("DBHash mismatch found for collection with uuid: " + uuid +
                          ". Primary info: " + tojsononeline(primaryInfo) +
                          ". Secondary info: " + tojsononeline(secondaryInfo));
                    const diff = rst.getCollectionDiffUsingSessions(
                        primarySession, secondarySession, dbName, primaryInfo.uuid);

                    result.push({
                        primary: primaryInfo,
                        secondary: secondaryInfo,
                        dbName: dbName,
                        diff: diff,
                    });
                }
            }
        }

        return result;
    };

    for (let dbName of dbNames) {
        let result;
        let clusterTime;
        let previousClusterTime;
        let hasTransientError;
        let performNoopWrite;

        // The isTransientError() function is responsible for setting hasTransientError to true.
        const isTransientError = (e) => {
            // It is possible for the ReplSetTest#getHashesUsingSessions() function to be
            // interrupted due to active sessions being killed by a test running concurrently.
            // We treat this as a transient error and simply retry running the dbHash check.
            //
            // Note that unlike auto_retry_transaction.js, we do not treat CursorKilled or
            // CursorNotFound error responses as transient errors because the
            // run_check_repl_dbhash_background.js hook would only establish a cursor via
            // ReplSetTest#getCollectionDiffUsingSessions() upon detecting a dbHash mismatch. It
            // is presumed to still useful to know that a bug exists even if we cannot get more
            // diagnostics for it.
            if (e.code === ErrorCodes.Interrupted) {
                hasTransientError = true;
            }

            // Perform a no-op write to the primary if the clusterTime between each call remain
            // the same and if we encounter the SnapshotUnavailable error as the secondaries
            // minimum timestamp can be greater than the primaries minimum timestamp.
            if (e.code === ErrorCodes.SnapshotUnavailable) {
                if (bsonBinaryEqual(clusterTime, previousClusterTime)) {
                    performNoopWrite = true;
                }
                hasTransientError = true;
            }

            // InvalidOptions can be returned when $_internalReadAtClusterTime is greater than
            // the all-committed timestamp. As the dbHash command is running in the background
            // at varying times, it's possible that we may run dbHash while a prepared
            // transactions has yet to commit or abort.
            if (e.code === ErrorCodes.InvalidOptions) {
                hasTransientError = true;
            }

            return hasTransientError;
        };

        do {
            // SERVER-38928: Due to races around advancing last applied, there's technically no
            // guarantee that a primary will report a later operation time than its
            // secondaries. Perform the snapshot read at the latest reported operation time.
            previousClusterTime = clusterTime;
            clusterTime = sessions[0].getOperationTime();
            let signedClusterTime = sessions[0].getClusterTime();
            for (let sess of sessions.slice(1)) {
                let ts = sess.getOperationTime();
                if (timestampCmp(ts, clusterTime) > 0) {
                    clusterTime = ts;
                    signedClusterTime = sess.getClusterTime();
                }
            }
            waitForSecondaries(clusterTime, signedClusterTime);

            for (let session of sessions) {
                debugInfo.push({
                    "node": session.getClient(),
                    "session": session,
                    "readAtClusterTime": clusterTime
                });
            }

            hasTransientError = false;
            performNoopWrite = false;

            try {
                result = checkCollectionHashesForDB(dbName, clusterTime);
            } catch (e) {
                if (isTransientError(e)) {
                    if (performNoopWrite) {
                        const primarySession = sessions[0];

                        // If the no-op write fails due to the global lock not being able to be
                        // acquired within 1 millisecond, retry the operation again at a later
                        // time.
                        assert.commandWorkedOrFailedWithCode(
                            primarySession.getDatabase(dbName).adminCommand(
                                {appendOplogNote: 1, data: {}}),
                            ErrorCodes.LockFailed);
                    }

                    debugInfo.push({"transientError": e, "performNoopWrite": performNoopWrite});
                    continue;
                }

                jsTestLog(debugInfo);
                throw e;
            }
        } while (hasTransientError);

        for (let mismatchInfo of result) {
            mismatchInfo.atClusterTime = clusterTime;
            results.push(mismatchInfo);
        }
    }

    for (let resetFn of resetFns) {
        resetFn();
    }

    const headings = [];
    let errorBlob = '';

    for (let mismatchInfo of results) {
        const diff = mismatchInfo.diff;
        delete mismatchInfo.diff;

        const heading =
            `dbhash mismatch for ${mismatchInfo.dbName}.${mismatchInfo.primary.collName}`;

        headings.push(heading);

        if (headings.length > 1) {
            errorBlob += '\n\n';
        }
        errorBlob += heading;
        errorBlob += `: ${tojson(mismatchInfo)}`;

        if (diff.docsWithDifferentContents.length > 0) {
            errorBlob += '\nThe following documents have different contents on the primary and' +
                ' secondary:';
            for (let {primary, secondary} of diff.docsWithDifferentContents) {
                errorBlob += `\n  primary:   ${tojsononeline(primary)}`;
                errorBlob += `\n  secondary: ${tojsononeline(secondary)}`;
            }
        } else {
            errorBlob += '\nNo documents have different contents on the primary and secondary';
        }

        if (diff.docsMissingOnPrimary.length > 0) {
            errorBlob += "\nThe following documents aren't present on the primary:";
            for (let doc of diff.docsMissingOnPrimary) {
                errorBlob += `\n  ${tojsononeline(doc)}`;
            }
        } else {
            errorBlob += '\nNo documents are missing from the primary';
        }

        if (diff.docsMissingOnSecondary.length > 0) {
            errorBlob += "\nThe following documents aren't present on the secondary:";
            for (let doc of diff.docsMissingOnSecondary) {
                errorBlob += `\n  ${tojsononeline(doc)}`;
            }
        } else {
            errorBlob += '\nNo documents are missing from the secondary';
        }
    }

    if (headings.length > 0) {
        for (let session of sessions) {
            const query = {};
            const limit = 100;
            rst.dumpOplog(session.getClient(), query, limit);
        }

        print(errorBlob);
        return {
            ok: 0,
            hosts: hosts,
            error: `dbhash mismatch (search for the following headings): ${tojson(headings)}`
        };
    }

    return {ok: 1};
}

if (topology.type === Topology.kReplicaSet) {
    let res = checkReplDbhashBackgroundThread(topology.nodes);
    assert.commandWorked(res, () => 'data consistency checks failed: ' + tojson(res));
} else if (topology.type === Topology.kShardedCluster) {
    const threads = [];
    try {
        if (topology.configsvr.nodes.length > 1) {
            const thread =
                new ScopedThread(checkReplDbhashBackgroundThread, topology.configsvr.nodes);
            threads.push(thread);
            thread.start();
        } else {
            print('Skipping data consistency checks for 1-node CSRS: ' +
                  tojsononeline(topology.configsvr));
        }

        for (let shardName of Object.keys(topology.shards)) {
            const shard = topology.shards[shardName];

            if (shard.type === Topology.kStandalone) {
                print('Skipping data consistency checks for stand-alone shard ' + shardName + ": " +
                      tojsononeline(shard));
                continue;
            }

            if (shard.type !== Topology.kReplicaSet) {
                throw new Error('Unrecognized topology format: ' + tojson(topology));
            }

            if (shard.nodes.length > 1) {
                const thread = new ScopedThread(checkReplDbhashBackgroundThread, shard.nodes);
                threads.push(thread);
                thread.start();
            } else {
                print('Skipping data consistency checks for stand-alone shard ' + shardName + ": " +
                      tojsononeline(shard));
            }
        }
    } finally {
        // Wait for each thread to finish. Throw an error if any thread fails.
        let exception;
        const returnData = threads.map(thread => {
            try {
                thread.join();
                return thread.returnData();
            } catch (e) {
                if (!exception) {
                    exception = e;
                }
            }
        });
        if (exception) {
            throw exception;
        }

        returnData.forEach(res => {
            assert.commandWorked(res, () => 'data consistency checks failed: ' + tojson(res));
        });
    }
} else {
    throw new Error('Unsupported topology configuration: ' + tojson(topology));
}
})();
