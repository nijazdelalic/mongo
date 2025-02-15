// Test simple updates issued through mongos. Updates have different constraints through mongos,
// since shard key is immutable.
(function() {

const s = new ShardingTest({name: "auto1", shards: 2, mongos: 1});

s.adminCommand({enablesharding: "test"});
s.ensurePrimaryShard('test', s.shard1.shardName);

db = s.getDB("test");

// Repeat same tests with hashed shard key, to ensure identical behavior.
s.shardColl("update0", {key: 1}, {key: 0}, {key: 1}, db.getName(), true);
s.adminCommand({shardcollection: "test.update1", key: {key: "hashed"}});

s.shard0.getDB("admin").setLogLevel(1);
s.shard1.getDB("admin").setLogLevel(1);

for (let i = 0; i < 2; i++) {
    const collName = "update" + i;
    const hashedKey = (collName == "update1");

    coll = db.getCollection(collName);
    coll.insert({_id: 1, key: 1});

    // Replacment and Opstyle upserts.
    assert.commandWorked(coll.update({_id: 2, key: 2}, {key: 2, foo: 'bar'}, {upsert: true}));
    assert.commandWorked(coll.update({_id: 3, key: 3}, {$set: {foo: 'bar'}}, {upsert: true}));

    assert.eq(coll.count(), 3, "count A");
    assert.eq(coll.findOne({_id: 3}).key, 3, "findOne 3 key A");
    assert.eq(coll.findOne({_id: 3}).foo, 'bar', "findOne 3 foo A");

    // update existing using update()
    assert.commandWorked(coll.update({_id: 1}, {key: 1, other: 1}));
    assert.commandWorked(coll.update({_id: 2}, {key: 2, other: 2}));
    assert.commandWorked(coll.update({_id: 3}, {key: 3, other: 3}));

    // do a replacement-style update which queries the shard key and keeps it constant
    assert.commandWorked(coll.update({key: 4}, {_id: 4, key: 4}, {upsert: true}));
    assert.commandWorked(coll.update({key: 4}, {key: 4, other: 4}));
    assert.eq(coll.find({key: 4, other: 4}).count(), 1, 'replacement update error');
    coll.remove({_id: 4});

    assert.eq(coll.count(), 3, "count B");
    coll.find().forEach(function(x) {
        assert.eq(x._id, x.key, "_id == key");
        assert.eq(x._id, x.other, "_id == other");
    });

    assert.writeError(coll.update({_id: 1, key: 1}, {$set: {key: 2}}));
    assert.eq(coll.findOne({_id: 1}).key, 1, 'key unchanged');

    assert.writeOK(coll.update({_id: 1, key: 1}, {$set: {foo: 2}}));

    coll.update({key: 17}, {$inc: {x: 5}}, true);
    assert.eq(5, coll.findOne({key: 17}).x, "up1");

    coll.update({key: 18}, {$inc: {x: 5}}, true, true);
    assert.eq(5, coll.findOne({key: 18}).x, "up2");

    // Make sure we can extract exact _id from certain queries
    assert.writeOK(coll.update({_id: ObjectId()}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({_id: {$eq: ObjectId()}}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({_id: {$all: [ObjectId()]}}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({$or: [{_id: ObjectId()}]}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({$and: [{_id: ObjectId()}]}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({_id: {$in: [ObjectId()]}}, {$set: {x: 1}}, {multi: false}));

    // Invalid extraction of exact _id from query
    assert.writeError(coll.update({}, {$set: {x: 1}}, {multi: false}));
    assert.writeError(coll.update({_id: {$gt: ObjectId()}}, {$set: {x: 1}}, {multi: false}));
    assert.writeError(
        coll.update({$or: [{_id: ObjectId()}, {_id: ObjectId()}]}, {$set: {x: 1}}, {multi: false}));
    assert.writeError(coll.update(
        {$and: [{_id: ObjectId()}, {_id: ObjectId()}]}, {$set: {x: 1}}, {multi: false}));
    assert.writeError(coll.update({'_id.x': ObjectId()}, {$set: {x: 1}}, {multi: false}));

    // Make sure we can extract exact shard key from certain queries
    assert.writeOK(coll.update({key: ObjectId()}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({key: {$eq: ObjectId()}}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({key: {$in: [ObjectId()]}}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({key: {$all: [ObjectId()]}}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({$or: [{key: ObjectId()}]}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({$and: [{key: ObjectId()}]}, {$set: {x: 1}}, {multi: false}));

    // Invalid extraction of exact key from query
    assert.writeError(coll.update({}, {$set: {x: 1}}, {multi: false}));
    assert.writeError(coll.update({'key.x': ObjectId()}, {$set: {x: 1}}, {multi: false}));

    // Inexact queries may target a single shard. Range queries may target a single shard as
    // long as the collection is not hashed.
    assert[hashedKey ? "writeError" : "writeOK"](
        coll.update({key: {$gt: 0}}, {$set: {x: 1}}, {multi: false}));
    // Note: {key:-1} and {key:-2} fall on shard0 for both hashed and ascending shardkeys.
    assert.writeOK(coll.update({$or: [{key: -1}, {key: -2}]}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({$and: [{key: -1}, {key: -2}]}, {$set: {x: 1}}, {multi: false}));

    // In cases where an inexact query does target multiple shards, single update is rejected.
    assert.writeError(coll.update({key: {$gt: MinKey}}, {$set: {x: 1}}, {multi: false}));
    assert.writeError(coll.update({$or: [{key: -10}, {key: 10}]}, {$set: {x: 1}}, {multi: false}));

    // Make sure failed shard key or _id extraction doesn't affect the other
    assert.writeOK(coll.update({'_id.x': ObjectId(), key: 1}, {$set: {x: 1}}, {multi: false}));
    assert.writeOK(coll.update({_id: ObjectId(), 'key.x': 1}, {$set: {x: 1}}, {multi: false}));
}

s.stop();
})();
