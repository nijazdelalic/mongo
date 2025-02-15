/*-
 * Copyright (c) 2014-2019 MongoDB, Inc.
 * Copyright (c) 2008-2014 WiredTiger, Inc.
 *	All rights reserved.
 *
 * See the file LICENSE for redistribution information.
 */

/*
 * __page_write_gen_wrapped_check --
 *	Confirm the page's write generation number won't wrap.
 */
static inline int
__page_write_gen_wrapped_check(WT_PAGE *page)
{
	/*
	 * Check to see if the page's write generation is about to wrap (wildly
	 * unlikely as it implies 4B updates between clean page reconciliations,
	 * but technically possible), and fail the update.
	 *
	 * The check is outside of the serialization mutex because the page's
	 * write generation is going to be a hot cache line, so technically it's
	 * possible for the page's write generation to wrap between the test and
	 * our subsequent modification of it.  However, the test is (4B-1M), and
	 * there cannot be a million threads that have done the test but not yet
	 * completed their modification.
	 */
	return (page->modify->write_gen >
	    UINT32_MAX - WT_MILLION ? WT_RESTART : 0);
}

/*
 * __insert_simple_func --
 *	Worker function to add a WT_INSERT entry to the middle of a skiplist.
 */
static inline int
__insert_simple_func(WT_SESSION_IMPL *session,
    WT_INSERT ***ins_stack, WT_INSERT *new_ins, u_int skipdepth)
{
	u_int i;

	WT_UNUSED(session);

	/*
	 * Update the skiplist elements referencing the new WT_INSERT item.
	 * If we fail connecting one of the upper levels in the skiplist,
	 * return success: the levels we updated are correct and sufficient.
	 * Even though we don't get the benefit of the memory we allocated,
	 * we can't roll back.
	 *
	 * All structure setup must be flushed before the structure is entered
	 * into the list. We need a write barrier here, our callers depend on
	 * it.  Don't pass complex arguments to the macro, some implementations
	 * read the old value multiple times.
	 */
	for (i = 0; i < skipdepth; i++) {
		WT_INSERT *old_ins = *ins_stack[i];
		if (old_ins != new_ins->next[i] ||
		    !__wt_atomic_cas_ptr(ins_stack[i], old_ins, new_ins))
			return (i == 0 ? WT_RESTART : 0);
	}

	return (0);
}

/*
 * __insert_serial_func --
 *	Worker function to add a WT_INSERT entry to a skiplist.
 */
static inline int
__insert_serial_func(WT_SESSION_IMPL *session, WT_INSERT_HEAD *ins_head,
    WT_INSERT ***ins_stack, WT_INSERT *new_ins, u_int skipdepth)
{
	u_int i;

	/* The cursor should be positioned. */
	WT_ASSERT(session, ins_stack[0] != NULL);

	/*
	 * Update the skiplist elements referencing the new WT_INSERT item.
	 *
	 * Confirm we are still in the expected position, and no item has been
	 * added where our insert belongs.  If we fail connecting one of the
	 * upper levels in the skiplist, return success: the levels we updated
	 * are correct and sufficient. Even though we don't get the benefit of
	 * the memory we allocated, we can't roll back.
	 *
	 * All structure setup must be flushed before the structure is entered
	 * into the list. We need a write barrier here, our callers depend on
	 * it.  Don't pass complex arguments to the macro, some implementations
	 * read the old value multiple times.
	 */
	for (i = 0; i < skipdepth; i++) {
		WT_INSERT *old_ins = *ins_stack[i];
		if (old_ins != new_ins->next[i] ||
		    !__wt_atomic_cas_ptr(ins_stack[i], old_ins, new_ins))
			return (i == 0 ? WT_RESTART : 0);
		if (ins_head->tail[i] == NULL ||
		    ins_stack[i] == &ins_head->tail[i]->next[i])
			ins_head->tail[i] = new_ins;
	}

	return (0);
}

/*
 * __col_append_serial_func --
 *	Worker function to allocate a record number as necessary, then add a
 * WT_INSERT entry to a skiplist.
 */
static inline int
__col_append_serial_func(WT_SESSION_IMPL *session, WT_INSERT_HEAD *ins_head,
    WT_INSERT ***ins_stack, WT_INSERT *new_ins, uint64_t *recnop,
    u_int skipdepth)
{
	WT_BTREE *btree;
	uint64_t recno;
	u_int i;

	btree = S2BT(session);

	/*
	 * If the application didn't specify a record number, allocate a new one
	 * and set up for an append.
	 */
	if ((recno = WT_INSERT_RECNO(new_ins)) == WT_RECNO_OOB) {
		recno = WT_INSERT_RECNO(new_ins) = btree->last_recno + 1;
		WT_ASSERT(session, WT_SKIP_LAST(ins_head) == NULL ||
		    recno > WT_INSERT_RECNO(WT_SKIP_LAST(ins_head)));
		for (i = 0; i < skipdepth; i++)
			ins_stack[i] = ins_head->tail[i] == NULL ?
			    &ins_head->head[i] : &ins_head->tail[i]->next[i];
	}

	/* Confirm position and insert the new WT_INSERT item. */
	WT_RET(__insert_serial_func(
	    session, ins_head, ins_stack, new_ins, skipdepth));

	/*
	 * Set the calling cursor's record number.
	 * If we extended the file, update the last record number.
	 */
	*recnop = recno;
	if (recno > btree->last_recno)
		btree->last_recno = recno;

	return (0);
}

/*
 * __wt_col_append_serial --
 *	Append a new column-store entry.
 */
static inline int
__wt_col_append_serial(WT_SESSION_IMPL *session, WT_PAGE *page,
    WT_INSERT_HEAD *ins_head, WT_INSERT ***ins_stack, WT_INSERT **new_insp,
    size_t new_ins_size, uint64_t *recnop, u_int skipdepth, bool exclusive)
{
	WT_DECL_RET;
	WT_INSERT *new_ins;

	/* Clear references to memory we now own and must free on error. */
	new_ins = *new_insp;
	*new_insp = NULL;

	/* Check for page write generation wrap. */
	WT_RET(__page_write_gen_wrapped_check(page));

	/*
	 * Acquire the page's spinlock unless we already have exclusive access.
	 * Then call the worker function.
	 */
	if (!exclusive)
		WT_PAGE_LOCK(session, page);
	ret = __col_append_serial_func(
	    session, ins_head, ins_stack, new_ins, recnop, skipdepth);
	if (!exclusive)
		WT_PAGE_UNLOCK(session, page);

	if (ret != 0) {
		/* Free unused memory on error. */
		__wt_free(session, new_ins);
		return (ret);
	}

	/*
	 * Increment in-memory footprint after releasing the mutex: that's safe
	 * because the structures we added cannot be discarded while visible to
	 * any running transaction, and we're a running transaction, which means
	 * there can be no corresponding delete until we complete.
	 */
	__wt_cache_page_inmem_incr(session, page, new_ins_size);

	/* Mark the page dirty after updating the footprint. */
	__wt_page_modify_set(session, page);

	return (0);
}

/*
 * __wt_insert_serial --
 *	Insert a row or column-store entry.
 */
static inline int
__wt_insert_serial(WT_SESSION_IMPL *session, WT_PAGE *page,
    WT_INSERT_HEAD *ins_head, WT_INSERT ***ins_stack, WT_INSERT **new_insp,
    size_t new_ins_size, u_int skipdepth, bool exclusive)
{
	WT_DECL_RET;
	WT_INSERT *new_ins;
	u_int i;
	bool simple;

	/* Clear references to memory we now own and must free on error. */
	new_ins = *new_insp;
	*new_insp = NULL;

	/* Check for page write generation wrap. */
	WT_RET(__page_write_gen_wrapped_check(page));

	simple = true;
	for (i = 0; i < skipdepth; i++)
		if (new_ins->next[i] == NULL)
			simple = false;

	if (simple)
		ret = __insert_simple_func(
		    session, ins_stack, new_ins, skipdepth);
	else {
		if (!exclusive)
			WT_PAGE_LOCK(session, page);
		ret = __insert_serial_func(
		    session, ins_head, ins_stack, new_ins, skipdepth);
		if (!exclusive)
			WT_PAGE_UNLOCK(session, page);
	}

	if (ret != 0) {
		/* Free unused memory on error. */
		__wt_free(session, new_ins);
		return (ret);
	}

	/*
	 * Increment in-memory footprint after releasing the mutex: that's safe
	 * because the structures we added cannot be discarded while visible to
	 * any running transaction, and we're a running transaction, which means
	 * there can be no corresponding delete until we complete.
	 */
	__wt_cache_page_inmem_incr(session, page, new_ins_size);

	/* Mark the page dirty after updating the footprint. */
	__wt_page_modify_set(session, page);

	return (0);
}

/*
 * __wt_update_serial --
 *	Update a row or column-store entry.
 */
static inline int
__wt_update_serial(WT_SESSION_IMPL *session, WT_PAGE *page,
    WT_UPDATE **srch_upd, WT_UPDATE **updp, size_t upd_size, bool exclusive)
{
	WT_DECL_RET;
	WT_UPDATE *obsolete, *upd;
	wt_timestamp_t obsolete_timestamp;
	uint64_t txn;

	/* Clear references to memory we now own and must free on error. */
	upd = *updp;
	*updp = NULL;

	/* Check for page write generation wrap. */
	WT_RET(__page_write_gen_wrapped_check(page));

	/*
	 * All structure setup must be flushed before the structure is entered
	 * into the list. We need a write barrier here, our callers depend on
	 * it.
	 *
	 * Swap the update into place.  If that fails, a new update was added
	 * after our search, we raced.  Check if our update is still permitted.
	 */
	while (!__wt_atomic_cas_ptr(srch_upd, upd->next, upd)) {
		if ((ret = __wt_txn_update_check(
		    session, upd->next = *srch_upd)) != 0) {
			/* Free unused memory on error. */
			__wt_free(session, upd);
			return (ret);
		}
	}

	/*
	 * Increment in-memory footprint after swapping the update into place.
	 * Safe because the structures we added cannot be discarded while
	 * visible to any running transaction, and we're a running transaction,
	 * which means there can be no corresponding delete until we complete.
	 */
	__wt_cache_page_inmem_incr(session, page, upd_size);

	/* Mark the page dirty after updating the footprint. */
	__wt_page_modify_set(session, page);

	/* If there are no subsequent WT_UPDATE structures we are done here. */
	if (upd->next == NULL || exclusive)
		return (0);

	/*
	 * We would like to call __wt_txn_update_oldest only in the event that
	 * there are further updates to this page, the check against WT_TXN_NONE
	 * is used as an indicator of there being further updates on this page.
	 */
	if ((txn = page->modify->obsolete_check_txn) != WT_TXN_NONE) {
		obsolete_timestamp = page->modify->obsolete_check_timestamp;
		if (!__wt_txn_visible_all(session, txn, obsolete_timestamp)) {
			/* Try to move the oldest ID forward and re-check. */
			WT_RET(__wt_txn_update_oldest(session, 0));

			if (!__wt_txn_visible_all(
			    session, txn, obsolete_timestamp))
				return (0);
		}

		page->modify->obsolete_check_txn = WT_TXN_NONE;
	}

	/* If we can't lock it, don't scan, that's okay. */
	if (WT_PAGE_TRYLOCK(session, page) != 0)
		return (0);

	obsolete = __wt_update_obsolete_check(session, page, upd->next, true);

	WT_PAGE_UNLOCK(session, page);

	if (obsolete != NULL)
		__wt_free_update_list(session, obsolete);

	return (0);
}
