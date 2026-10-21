import Page from 'flarum/common/components/Page';
import ItemList from 'flarum/common/utils/ItemList';
import LoadingIndicator from 'flarum/common/components/LoadingIndicator';
import Button from 'flarum/common/components/Button';
import PageStructure from 'flarum/forum/components/PageStructure';
import SupportIndexSidebar from './SupportIndexSidebar';
import TicketHeader from './TicketHeader';
import ReplyItem from './ReplyItem';
import TicketEventItem from './TicketEventItem';
import SavedRepliesMenu from './SavedRepliesMenu';
import ReplyComposer from './ReplyComposer';
import { tr } from '../utils/translate';
import { basePath, BASE_PATH, safeNavigate, showError } from '../utils/helpers';
import { canHandleSupportTickets } from '../utils/permissions';
import { loadTicket, loadReplies, loadEvents, markTicketRead, postReply, uploadFilesToBody } from '../utils/api';
import { onLive } from '../utils/live';
import { refreshCounts } from '../utils/counts';
import { openSupportComposer, supportComposerSupported } from '../utils/composer';
import { ticketTypes } from '../../common/ticketTypes';

// Orchestrates the ticket detail page: owns loading/error state, the ticket and
// its (paginated) replies, and all mutation logic. Rendering is delegated to
// the presentational TicketHeader / ReplyItem / ReplyComposer
// components, which receive data + callbacks.
export default class SupportShowPage extends Page<any> {
  loading = true;
  loadingMore = false;
  error: any = null;
  ticket: any = null;
  replies: any[] = [];
  // Status and assignment changes, shown between the replies by time.
  events: any[] = [];
  _stopLive: (() => void) | null = null;
  // Whether every reply up to now is on screen. Kept as its own flag rather
  // than derived from the ticket's reply count, because a live push can raise
  // that count before the new reply itself has been fetched.
  _allLoaded = false;
  _catchingUp = false;
  _catchUpAgain = false;
  replyText = '';
  replyIsInternal = false;
  posting = false;
  updating = false;
  uploadingCount = 0;
  uploadError: any = null;
  _ticketId: any = null;
  _ticketBusy = false;
  _replyEditState: Record<string, any> | null = null;
  _replyFileInput: any = null;
  _replyComposer: any = null;
  _replyEditorNonce = 0;
  // Replies load a page at a time; a "Load more" button fetches the next page.
  _replyLimit = 50;

  oninit(vnode: any) {
    super.oninit(vnode);
    this.loading = true;
    this.error = null;
    this.ticket = null;
    this.replies = [];
    this.events = [];
    this.replyText = '';
    this.replyIsInternal = false;
    this.posting = false;
    this.updating = false;
    this.uploadingCount = 0;
    this.uploadError = null;
    try {
      app.setTitle(tr('show.title', 'Ticket'));
    } catch (e) {}
    this._ticketId = (this.attrs && this.attrs.id) || null;
    if (this._ticketId) this._load();
  }

  oncreate(vnode: any) {
    super.oncreate(vnode);
    this._stopLive = onLive((kind, id) => this._onLive(kind, id));
  }

  onremove(vnode: any) {
    if (this._stopLive) this._stopLive();
    this._stopLive = null;
    super.onremove(vnode);
  }

  onupdate(vnode: any) {
    if (super.onupdate as any) super.onupdate(vnode);
    const newId = (this.attrs && this.attrs.id) || null;
    if (newId !== this._ticketId) {
      this._ticketId = newId;
      this.loading = true;
      this.ticket = null;
      this.replies = [];
      this.events = [];
      if (newId) this._load();
    }
  }

  _load() {
    this.loading = true;
    m.redraw();

    Promise.all([
      loadTicket(this._ticketId),
      loadReplies(this._ticketId, 0, this._replyLimit),
      // History is a nicety: if it fails to load, the ticket still shows.
      loadEvents(this._ticketId).catch(() => []),
    ])
      .then((results: any[]) => {
        this.ticket = results[0];
        this.replies = results[1] || [];
        this.events = results[2] || [];
        this._allLoaded = this._countsAllLoaded();
        this.loading = false;
        markTicketRead(this.ticket);
        try {
          const t = this.ticket && this.ticket.subject();
          if (t) app.setTitle(t);
        } catch (e) {}
        m.redraw();
      })
      .catch((err: any) => {
        this.error = err;
        this.loading = false;
        console.error('[linkrobins/support] ticket load failed:', err);
        m.redraw();
      });
  }

  // Fetch the next page of replies (sorted oldest-first) and append them.
  _loadMoreReplies() {
    if (this.loadingMore || !this._ticketId) return;
    this.loadingMore = true;
    m.redraw();

    loadReplies(this._ticketId, this.replies.length, this._replyLimit)
      .then((more: any[]) => {
        // Guard against any overlap if the list shifted between requests.
        const seen = new Set((this.replies || []).map((r: any) => String(r.id())));
        const fresh = (more || []).filter((r: any) => !seen.has(String(r.id())));
        this.replies = (this.replies || []).concat(fresh);
        this._allLoaded = this._countsAllLoaded();
        this.loadingMore = false;
        m.redraw();
      })
      .catch((err: any) => {
        this.loadingMore = false;
        console.error('[linkrobins/support] load more replies failed:', err);
        showError(tr('errors.load_more_replies', 'Could not load more replies.'));
        m.redraw();
      });
  }

  _wrap(inner: any) {
    return m(
      PageStructure,
      {
        className: 'IndexPage LinkRobinsSupport-page',
        // Highlight the sidebar item this ticket belongs to: its status for
        // staff (who see the status views), or "My tickets" for the owner.
        // Null while the ticket is still loading.
        sidebar: () =>
          m(SupportIndexSidebar, {
            className: 'LinkRobinsSupport-sidebar',
            activeFilter: this.ticket ? (canHandleSupportTickets() ? this.ticket.status() : 'mine') : null,
          }),
      },
      inner
    );
  }

  view() {
    if (this.loading) {
      return this._wrap(m('div', { className: 'LinkRobinsSupport-container' }, m(LoadingIndicator)));
    }
    if (this.error || !this.ticket) {
      return this._wrap(
        m('div', { className: 'LinkRobinsSupport-container' }, [
          m('header', { className: 'LinkRobinsSupport-header' }, [
            // Back link first: the header is a column, so this reads as a
            // breadcrumb above the title instead of a second column beside it.
            m(
              'a',
              {
                href: basePath() + BASE_PATH,
                className: 'Button Button--text LinkRobinsSupport-backBtn',
                onclick: (e: any) => {
                  safeNavigate(basePath() + BASE_PATH, e);
                },
              },
              [m('i', { className: 'fas fa-arrow-left' }), ' ', tr('action.back', 'Back')]
            ),
            m('h1', { className: 'LinkRobinsSupport-title' }, tr('show.title', 'Ticket')),
          ]),
          m(
            'div',
            { className: 'LinkRobinsSupport-empty' },
            tr('errors.load_ticket', 'Could not load this ticket. It may have been deleted, or you may not have permission to view it.')
          ),
        ])
      );
    }

    const ticket = this.ticket;
    const isDeleted = !!ticket.isDeleted();
    const canModerate = canHandleSupportTickets() || !!ticket.canDelete();

    return this._wrap(
      m('div', { className: 'LinkRobinsSupport-container' + (isDeleted ? ' LinkRobinsSupport-container--deleted' : '') }, [
        m(TicketHeader, {
          ticket,
          canModerate,
          isStaff: canHandleSupportTickets(),
          updating: this.updating,
          onSetStatus: (s: string) => this._setStatus(s),
          onSetDecision: (d: string) => this._setDecision(d),
          onAssign: (member: any) => this._assignTo(member),
          onSetPriority: (priority: string) => this._setPriority(priority),
          ticketBusy: this._ticketBusy,
          onSoftDelete: () => this._softDeleteTicket(),
          onRestore: () => this._restoreTicket(),
          onForceDelete: () => this._forceDeleteTicket(),
        }),

        this.content(ticket),

        m(
          'div',
          { className: 'LinkRobinsSupport-replies' },
          this._timeline().map((entry: any) =>
            entry.kind === 'event' ? m(TicketEventItem, { key: 'event-' + entry.item.id(), event: entry.item }) : this._renderReply(entry.item)
          )
        ),

        this._renderLoadMore(),

        this._renderConfirmSolved(),

        ticket.canReply()
          ? m(ReplyComposer, {
              ticket,
              posting: this.posting,
              replyText: this.replyText,
              replyIsInternal: this.replyIsInternal,
              uploadingCount: this.uploadingCount,
              uploadError: this.uploadError,
              onOpenComposer: (canPostInternal: boolean) => this._openReplyComposer(canPostInternal),
              onSubmit: () => this._postReply(),
              onReplyTextInput: (v: string) => {
                this.replyText = v;
              },
              onToggleInternal: (v: boolean) => {
                this.replyIsInternal = v;
              },
              onAttachClick: () => {
                if (this._replyFileInput) this._replyFileInput.click();
              },
              onFileInputCreate: (dom: any) => {
                this._replyFileInput = dom;
              },
              onFileInputRemove: () => {
                this._replyFileInput = null;
              },
              onFilesChosen: (files: any) => this._uploadFiles(files),
            })
          : m('div', { className: 'LinkRobinsSupport-empty' }, [
              ticket.status() === 'closed'
                ? tr('show.closed_notice', 'This ticket has been closed and cannot be replied to.')
                : tr('show.cannot_reply', 'You cannot reply to this ticket.'),
              // Owner-facing Reopen button on a closed ticket (staff use the
              // status bar above instead). canReopen is false for appeals.
              ticket.status() === 'closed' && ticket.canReopen() && !canHandleSupportTickets()
                ? m(
                    'div',
                    { className: 'LinkRobinsSupport-reopenRow' },
                    m(
                      'button',
                      {
                        type: 'button',
                        className: 'Button Button--primary',
                        disabled: this.updating,
                        onclick: () => this._reopen(),
                      },
                      tr('action.reopen', 'Reopen ticket')
                    )
                  )
                : null,
            ]),
      ])
    );
  }

  content(ticket: any) {
    const items = this.contentItems(ticket);
    if (items.isEmpty()) return null;

    return m('div', { className: 'LinkRobinsSupport-ticket-content' }, items.toArray());
  }

  contentItems(ticket: any) {
    const items = new ItemList();
    const category = ticket && ticket.category && ticket.category();
    if (category) {
      const driver = ticketTypes.forCategory(category);
      if (driver && driver.contentItems) {
        driver.contentItems(items, ticket);
      }
    }
    return items;
  }

  /**
   * For the owner of a resolved ticket: confirm it is solved (which closes
   * it), or say it is not (which opens the reply box; replying to a resolved
   * ticket already puts it back in progress).
   */
  _renderConfirmSolved() {
    const ticket = this.ticket;
    if (!ticket || !(ticket.canConfirmSolved && ticket.canConfirmSolved())) return null;

    return m('div', { className: 'LinkRobinsSupport-confirmSolved' }, [
      m('div', { className: 'LinkRobinsSupport-confirmSolved-text' }, [
        m('i', { className: 'fas fa-check-circle', 'aria-hidden': 'true' }),
        ' ',
        tr('show.confirm_solved_prompt', 'This ticket was marked resolved. Did this solve your problem?'),
      ]),
      m('div', { className: 'LinkRobinsSupport-confirmSolved-actions' }, [
        m(
          Button,
          { className: 'Button Button--primary', disabled: this.updating, onclick: () => this._confirmSolved() },
          tr('show.confirm_solved_yes', 'Yes, close it')
        ),
        m(
          Button,
          { className: 'Button', disabled: this.updating, onclick: () => this._openReplyComposer(false) },
          tr('show.confirm_solved_no', 'No, I still need help')
        ),
      ]),
    ]);
  }

  _confirmSolved() {
    this.updating = true;
    m.redraw();
    this.ticket
      .save({ status: 'closed' })
      .then(() => {
        this.updating = false;
        m.redraw();
        this._refreshEvents();
      })
      .catch((err: any) => {
        this.updating = false;
        console.error('[linkrobins/support] confirm solved failed:', err);
        showError(tr('errors.update_status', 'Could not update status.'));
        m.redraw();
      });
  }

  _renderReply(r: any) {
    return m(ReplyItem, {
      key: 'reply-' + r.id(),
      reply: r,
      editState: this._replyEditState ? this._replyEditState[r.id()] : null,
      onBeginEdit: (rep: any) => this._beginEditReply(rep),
      onSaveEditInline: (rep: any) => this._saveEditReply(rep),
      onCancelEdit: (rep: any) => this._cancelEditReply(rep),
      onSoftDelete: (rep: any) => this._softDeleteReply(rep),
      onRestore: (rep: any) => this._restoreReply(rep),
      onForceDelete: (rep: any) => this._forceDeleteReply(rep),
    });
  }

  /**
   * Replies and history entries in time order. While older replies are still
   * waiting behind "Load more", history after the last loaded reply is held
   * back too, so an entry never appears above a reply that came before it.
   */
  _timeline(): Array<{ kind: 'reply' | 'event'; item: any }> {
    const replies = this.replies || [];
    const total = this.ticket && typeof this.ticket.replyCount === 'function' ? this.ticket.replyCount() : null;
    const moreToLoad = total != null && replies.length < total;
    const last = replies.length ? replies[replies.length - 1].createdAt() : null;
    const time = (d: any) => (d instanceof Date ? d.getTime() : 0);

    const events = (this.events || []).filter((e: any) => !moreToLoad || (last && time(e.createdAt()) <= time(last)));

    const entries: Array<{ kind: 'reply' | 'event'; item: any; at: number; order: number }> = [];
    replies.forEach((r: any, i: number) => entries.push({ kind: 'reply', item: r, at: time(r.createdAt()), order: i }));
    events.forEach((e: any, i: number) => entries.push({ kind: 'event', item: e, at: time(e.createdAt()), order: i }));

    // A reply that moves the status writes its history entry in the same
    // second; keep the reply first so the line reads as its consequence.
    return entries.sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.order - b.order : a.kind === 'reply' ? -1 : 1));
  }

  _refreshEvents() {
    if (!this._ticketId) return;
    loadEvents(this._ticketId)
      .then((events: any[]) => {
        this.events = events || [];
        m.redraw();
      })
      .catch(() => {});
  }

  _countsAllLoaded(): boolean {
    const total = this.ticket && typeof this.ticket.replyCount === 'function' ? this.ticket.replyCount() : null;
    return total == null || (this.replies || []).length >= total;
  }

  /**
   * A live update arrived. A ticket push carries the ticket's id; a reply push
   * carries linkage to its ticket, read raw because reply.ticket() resolves
   * through the store and is empty for a ticket that was never loaded --
   * exactly the case of another ticket's reply. Without linkage the reply is
   * treated as possibly ours. A ticket push has already been merged into the
   * store, so the header and status bar redraw on their own.
   */
  _onLive(kind: string, id: string | null) {
    if (!this.ticket || this.loading) return;
    const ours = String(this.ticket.id());
    if (kind === 'ticket' && id !== ours) return;
    if (kind === 'reply' && id) {
      const reply: any = app.store.getById('linkrobins-support-replies', id);
      const ticketId = reply?.data?.relationships?.ticket?.data?.id;
      if (ticketId != null && String(ticketId) !== ours) return;
    }
    this._catchUp();
  }

  /**
   * Bring the page up to date: append replies that are new since everything
   * was last on screen, then refresh the ticket (reply count) and its history.
   * When older replies are still behind "Load more", only the ticket is
   * refreshed, and "Load more" picks the new ones up in order. One reply
   * usually arrives as two pushes (the reply and the ticket it moved), so
   * overlapping calls are folded into one follow-up run.
   */
  _catchUp() {
    if (this._catchingUp) {
      this._catchUpAgain = true;
      return;
    }
    this._catchingUp = true;

    const done = () => {
      this._catchingUp = false;
      if (this._catchUpAgain) {
        this._catchUpAgain = false;
        this._catchUp();
      }
    };

    if (!this._allLoaded) {
      this._refreshTicket();
      done();
      return;
    }

    loadReplies(this._ticketId, this.replies.length, this._replyLimit)
      .then((more: any[]) => {
        const seen = new Set((this.replies || []).map((r: any) => String(r.id())));
        const fresh = (more || []).filter((r: any) => !seen.has(String(r.id())));
        if (fresh.length) this.replies = this.replies.concat(fresh);
        m.redraw();
        this._refreshTicket();
        // They are looking at it, so what just arrived is read.
        if (fresh.length) markTicketRead(this.ticket);
      })
      .catch(() => {})
      .then(done);
  }

  // "Load more replies" button, shown while fewer replies are loaded than the
  // ticket's reply count (which respects the same visibility as the list).
  _renderLoadMore() {
    const ticket = this.ticket;
    const total = ticket && typeof ticket.replyCount === 'function' ? ticket.replyCount() : null;
    if (total == null || this.replies.length >= total) return null;

    return m(
      'div',
      { className: 'LinkRobinsSupport-loadMore' },
      m(
        'button',
        {
          type: 'button',
          className: 'Button Button--default LinkRobinsSupport-loadMoreBtn',
          disabled: this.loadingMore,
          onclick: () => {
            this._loadMoreReplies();
          },
        },
        this.loadingMore ? tr('action.loading_more', 'Loading…') : tr('action.load_more_replies', 'Load more replies')
      )
    );
  }

  // --- Staff controls ----------------------------------------------------

  /** Assign to a staff member picked in AssignTicketModal, or unassign (null). */
  _assignTo(user: any | null) {
    this._setAssignment(user);
  }

  _setAssignment(user: any) {
    this.updating = true;
    m.redraw();
    this.ticket
      .save({ relationships: { assignedStaff: user } })
      .then(() => {
        // The PATCH response omits a now-null ToOne relationship (the server
        // doesn't echo it back, even when included), so the local model would
        // keep the stale assignee. Clear it explicitly on unassign.
        if (!user && typeof this.ticket.pushData === 'function') {
          this.ticket.pushData({ relationships: { assignedStaff: { data: null } } });
        }
        this.updating = false;
        m.redraw();
        this._refreshEvents();
        refreshCounts();
      })
      .catch((err: any) => {
        this.updating = false;
        console.error('[linkrobins/support] assignment update failed:', err);
        showError(tr('errors.update_assignment', 'Could not update assignment.'));
        m.redraw();
      });
  }

  // Reopen a closed ticket: put it back to 'open' so staff can act on it again.
  // Goes through _setStatus, which skips the close-confirm for non-close changes.
  _reopen() {
    this._setStatus('open');
  }

  _setStatus(status: string) {
    // Closing blocks all further replies, and it's easy to pick from the
    // dropdown by accident, so confirm first. (Reopening and other changes are
    // not gated.)
    if (status === 'closed') {
      try {
        if (!window.confirm(tr('confirm.close_ticket', 'Close this ticket? It cannot be replied to until it is reopened.'))) {
          m.redraw(); // reset the status dropdown to the current value
          return;
        }
      } catch (e) {}
    }

    this.updating = true;
    m.redraw();
    this.ticket
      .save({ status })
      .then(() => {
        this.updating = false;
        m.redraw();
        this._refreshEvents();
        refreshCounts();
      })
      .catch((err: any) => {
        this.updating = false;
        console.error('[linkrobins/support] status update failed:', err);
        showError(tr('errors.update_status', 'Could not update status.'));
        m.redraw();
      });
  }

  _setPriority(priority: string) {
    this.updating = true;
    m.redraw();
    this.ticket
      .save({ priority })
      .then(() => {
        this.updating = false;
        m.redraw();
      })
      .catch((err: any) => {
        this.updating = false;
        console.error('[linkrobins/support] priority update failed:', err);
        showError(tr('errors.update_priority', 'Could not update the priority.'));
        m.redraw();
      });
  }

  _setDecision(decision: string) {
    this.updating = true;
    m.redraw();
    this.ticket
      .save({ decision })
      .then(() => {
        this.updating = false;
        m.redraw();
      })
      .catch((err: any) => {
        this.updating = false;
        console.error('[linkrobins/support] decision update failed:', err);
        showError(tr('errors.update_decision', 'Could not update the decision.'));
        m.redraw();
      });
  }

  // --- Reply editing / moderation ----------------------------------------

  _beginEditReply(reply: any) {
    // Pre-fill with the original markdown source so editing preserves format.
    const draft = typeof reply.content() === 'string' ? reply.content() : '';

    // Preferred path: edit in the docked composer (rich text / mentions /
    // upload all work, matching editing a post on the forum).
    if (supportComposerSupported()) {
      openSupportComposer({
        supportContext: 'edit-reply:' + reply.id(),
        className: 'LinkRobinsSupport-replyComposer',
        placeholder: tr('reply.placeholder', 'Write a reply…'),
        submitLabel: tr('action.save_changes', 'Save changes'),
        confirmExit: tr('reply.discard_confirm', 'You have unsaved changes. Discard them?'),
        originalContent: draft,
        supportHeaderItems: () => [
          {
            name: 'title',
            content: m('h3', { className: 'LinkRobinsSupport-composerTitle' }, [
              m('i', { className: 'fas fa-pencil-alt' }),
              ' ',
              tr('action.edit_reply', 'Edit reply'),
            ]),
          },
        ],
        onSupportSubmit: (content: string, body: any) => {
          this._saveEditReply(reply, content, body);
        },
      });
      return;
    }

    // Fallback: inline textarea editor.
    if (!this._replyEditState) this._replyEditState = {};
    this._replyEditState[reply.id()] = { editing: true, draft, busy: false };
    m.redraw();
  }

  _cancelEditReply(reply: any) {
    if (this._replyEditState) delete this._replyEditState[reply.id()];
    m.redraw();
  }

  // Save a reply edit. Called from the docked composer with (reply, content,
  // body), or from the fallback inline editor with just (reply).
  _saveEditReply(reply: any, content?: string, body?: any) {
    const state = this._replyEditState && this._replyEditState[reply.id()];
    const text = typeof content === 'string' ? content : state ? state.draft : '';
    if (!text || text.trim() === '') return;
    if (!content && !state) return;

    if (state) state.busy = true;
    if (body) body.loading = true;
    m.redraw();

    // Override the URL to request the editedBy/user relationships back so the
    // "(edited) by X" marker refreshes from the server's response.
    reply
      .save(
        { content: text },
        {
          url: app.forum.attribute('apiUrl') + '/linkrobins-support-replies/' + reply.id() + '?include=user,editedBy',
        }
      )
      .then(() => {
        if (this._replyEditState) delete this._replyEditState[reply.id()];
        if (body && body.composer) body.composer.hide();
        m.redraw();
      })
      .catch((err: any) => {
        if (state) state.busy = false;
        if (body) body.loading = false;
        console.error('[linkrobins/support] edit reply failed:', err);
        showError(tr('errors.save_edit', 'Could not save the edit.'));
        m.redraw();
      });
  }

  _softDeleteReply(reply: any) {
    try {
      if (!window.confirm(tr('confirm.soft_delete_reply', 'Soft-delete this reply? Staff can restore it later.'))) return;
    } catch (e) {}
    this._patchReplyDeletedState(reply, true);
  }

  _restoreReply(reply: any) {
    this._patchReplyDeletedState(reply, false);
  }

  _patchReplyDeletedState(reply: any, isDeleted: boolean) {
    this._setReplyBusy(reply.id(), true);

    reply
      .save({ isDeleted })
      .then(() => {
        this._setReplyBusy(reply.id(), false);
        m.redraw();
      })
      .catch((err: any) => {
        this._setReplyBusy(reply.id(), false);
        console.error('[linkrobins/support] toggle delete failed:', err);
        showError(isDeleted ? tr('errors.delete_reply', 'Could not delete the reply.') : tr('errors.restore_reply', 'Could not restore the reply.'));
        m.redraw();
      });
  }

  _forceDeleteReply(reply: any) {
    try {
      if (!window.confirm(tr('confirm.delete_reply_forever', 'Permanently delete this reply? This cannot be undone.'))) return;
    } catch (e) {}
    this._setReplyBusy(reply.id(), true);

    reply
      .delete()
      .then(() => {
        this.replies = (this.replies || []).filter((r: any) => String(r.id()) !== String(reply.id()));
        if (this._replyEditState) delete this._replyEditState[reply.id()];
        // A permanent delete removes the row on the server, so its reply count
        // drops too. Mirror that on the cached ticket, otherwise replyCount()
        // still reflects the pre-delete total and _renderLoadMore shows a stray
        // "Load more" button until the page is refreshed (support#5).
        const ticket = this.ticket;
        if (ticket && typeof ticket.replyCount === 'function') {
          const current = ticket.replyCount();
          if (typeof current === 'number') {
            ticket.pushAttributes({ replyCount: Math.max(0, current - 1) });
          }
        }
        m.redraw();
      })
      .catch((err: any) => {
        this._setReplyBusy(reply.id(), false);
        console.error('[linkrobins/support] force delete failed:', err);
        showError(tr('errors.delete_reply_forever', 'Could not permanently delete the reply.'));
        m.redraw();
      });
  }

  _setReplyBusy(replyId: string, busy: boolean) {
    if (!this._replyEditState) this._replyEditState = {};
    const existing = this._replyEditState[replyId];
    if (existing) {
      existing.busy = busy;
    } else if (busy) {
      this._replyEditState[replyId] = { editing: false, draft: '', busy: true };
    }
    if (!busy && this._replyEditState[replyId] && !this._replyEditState[replyId].editing) {
      delete this._replyEditState[replyId];
    }
  }

  // --- Ticket moderation -------------------------------------------------

  _softDeleteTicket() {
    try {
      if (
        !window.confirm(
          tr(
            'confirm.soft_delete_ticket',
            'Soft-delete this ticket? It will be hidden from the index and from the ticket owner; staff can restore it.'
          )
        )
      )
        return;
    } catch (e) {}
    this._patchTicketDeletedState(true);
  }

  _restoreTicket() {
    this._patchTicketDeletedState(false);
  }

  _patchTicketDeletedState(isDeleted: boolean) {
    if (!this.ticket) return;
    this._ticketBusy = true;
    m.redraw();

    this.ticket
      .save({ isDeleted })
      .then(() => {
        this._ticketBusy = false;
        m.redraw();
      })
      .catch((err: any) => {
        this._ticketBusy = false;
        console.error('[linkrobins/support] ticket delete toggle failed:', err);
        showError(
          isDeleted ? tr('errors.delete_ticket', 'Could not delete the ticket.') : tr('errors.restore_ticket', 'Could not restore the ticket.')
        );
        m.redraw();
      });
  }

  _forceDeleteTicket() {
    if (!this.ticket) return;
    try {
      if (!window.confirm(tr('confirm.delete_ticket_forever', 'Permanently delete this ticket and all its replies? This cannot be undone.'))) return;
    } catch (e) {}
    this._ticketBusy = true;
    m.redraw();

    this.ticket
      .delete()
      .then(() => {
        // After permanent deletion the ticket is gone -- navigate back to the
        // index so the user isn't on a stale page that 404s on refetch.
        try {
          m.route.set(app.route('linkrobins-support.index'));
        } catch (e) {}
      })
      .catch((err: any) => {
        this._ticketBusy = false;
        console.error('[linkrobins/support] ticket force delete failed:', err);
        showError(tr('errors.delete_ticket_forever', 'Could not permanently delete the ticket.'));
        m.redraw();
      });
  }

  // --- Reply composer ----------------------------------------------------

  // Open the docked composer to write a reply / internal note.
  _openReplyComposer(canPostInternal: boolean) {
    const ticket = this.ticket;
    const subject = ticket.subject() || '';
    openSupportComposer({
      supportContext: 'reply:' + ticket.id(),
      className: 'LinkRobinsSupport-replyComposer',
      placeholder: tr('reply.placeholder', 'Write a reply…'),
      submitLabel: tr('reply.post_reply', 'Post reply'),
      confirmExit: tr('reply.discard_confirm', 'You have an unsaved reply. Discard it?'),
      originalContent: '',
      supportHeaderItems: (body: any) => {
        const rows: any[] = [
          {
            name: 'title',
            priority: 10,
            content: m('h3', { className: 'LinkRobinsSupport-composerTitle' }, [m('i', { className: 'fas fa-reply' }), ' ', subject]),
          },
        ];
        if (canPostInternal) {
          rows.push({
            name: 'internal',
            content: m('label', { className: 'LinkRobinsSupport-internalToggle' }, [
              m('input', {
                type: 'checkbox',
                checked: !!body._supportInternal,
                onchange: (e: any) => {
                  body._supportInternal = !!e.target.checked;
                },
              }),
              ' ',
              tr('reply.internal_note', 'Internal note'),
            ]),
          });
          rows.push({ name: 'savedReplies', content: m(SavedRepliesMenu) });
        }
        return rows;
      },
      onSupportSubmit: (content: string, body: any) => {
        this._postReply(content, !!body._supportInternal, body);
      },
    });
  }

  _uploadFiles(files: FileList) {
    return uploadFilesToBody(this, files, 'replyText', () => this._replyComposer && this._replyComposer.editor);
  }

  _refreshTicket() {
    loadTicket(this._ticketId)
      .then((ticket: any) => {
        this.ticket = ticket;
        m.redraw();
      })
      .catch(() => {});
    // A reply can move the status or claim the ticket; show that in history.
    this._refreshEvents();
  }

  // Post a reply. Called from the docked composer with (content, isInternal,
  // body), or from the fallback textarea with no args.
  _postReply(content?: string, isInternal?: boolean, body?: any) {
    const text = typeof content === 'string' ? content : this.replyText;
    const internal = typeof isInternal === 'boolean' ? isInternal : !!this.replyIsInternal;
    if (!text || text.trim() === '') return;

    this.posting = true;
    if (body) body.loading = true;
    m.redraw();

    postReply(this.ticket, text, internal)
      .then((reply: any) => {
        this.posting = false;
        this.uploadError = null;
        this.uploadingCount = 0;
        if (body && body.composer) {
          body.composer.hide();
        } else {
          this.replyText = '';
          this.replyIsInternal = false;
          this._replyEditorNonce = (this._replyEditorNonce || 0) + 1;
        }
        // Append the new reply in place rather than a full reload, then refresh
        // the ticket so any server-side status/assignment change is reflected.
        if (reply) {
          this.replies = (this.replies || []).concat([reply]);
        }
        m.redraw();
        this._refreshTicket();
      })
      .catch((err: any) => {
        this.posting = false;
        if (body) body.loading = false;
        console.error('[linkrobins/support] reply failed:', err);
        showError(tr('errors.post_reply', 'Could not post reply.'));
        m.redraw();
      });
  }
}
