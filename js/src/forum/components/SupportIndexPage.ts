import Page from 'flarum/common/components/Page';
import LoadingIndicator from 'flarum/common/components/LoadingIndicator';
import Avatar from 'flarum/common/components/Avatar';
import Button from 'flarum/common/components/Button';
import PageStructure from 'flarum/forum/components/PageStructure';
import SupportIndexSidebar from './SupportIndexSidebar';
import { tr, trText } from '../utils/translate';
import { basePath, BASE_PATH, formatDate, safeNavigate, showError } from '../utils/helpers';
import { canCreateSupportTicket, canHandleSupportTickets } from '../utils/permissions';
import { statusChip, priorityChip, FILTER_OPTIONS, filterLabel, emptyLabel } from '../utils/status';
import { loadTickets } from '../utils/api';
import { onLive, throttleLive, LiveThrottle } from '../utils/live';
import ItemList from 'flarum/common/utils/ItemList';
import { ticketTypes } from '../../common/ticketTypes';

const PAGE_SIZE = 25;

export default class SupportIndexPage extends Page {
  loading = true;
  error: any = null;
  tickets: any[] = [];
  // Lists load a page at a time; "Load more" fetches the next one.
  hasMore = false;
  loadingMore = false;
  // Search within the current view; empty means no search.
  query = '';
  _searchTimer: any = null;
  // Each load gets a number; a response that is not the latest is dropped,
  // so a slow reply for "ava" cannot overwrite the results for "avatar".
  _loadSeq = 0;
  filter: string | null = 'mine';
  _lastLoadedFilter: string | null = 'mine';
  _stopLive: (() => void) | null = null;
  _liveReload: LiveThrottle | null = null;

  oninit(vnode: any) {
    super.oninit(vnode);
    this.loading = true;
    this.error = null;
    this.tickets = [];
    this.filter = this._filterFromAttrs(this.attrs);
    try {
      app.setTitle(tr('nav', 'Support'));
    } catch (e) {}
    this._lastLoadedFilter = this.filter;
    this._load();
  }

  oncreate(vnode: any) {
    super.oncreate(vnode);
    // A ticket opened or moved somewhere: refetch the list in place so new
    // tickets appear and moved ones leave this view. Throttled, since pushes
    // arrive for activity anywhere on the desk (see throttleLive).
    const reload = throttleLive(() => this._load(true));
    this._liveReload = reload;
    this._stopLive = onLive((kind) => {
      if (kind === 'ticket') reload.call();
    });
  }

  onremove(vnode: any) {
    if (this._stopLive) this._stopLive();
    this._stopLive = null;
    if (this._liveReload) this._liveReload.cancel();
    this._liveReload = null;
    clearTimeout(this._searchTimer);
    super.onremove(vnode);
  }

  onbeforeupdate(vnode: any) {
    const nextFilter = this._filterFromAttrs(vnode.attrs);
    if (nextFilter !== this._lastLoadedFilter) {
      this.filter = nextFilter;
      this._lastLoadedFilter = nextFilter;
      Promise.resolve().then(() => this._load());
    }
    return true;
  }

  _filterFromAttrs(attrs: any): string {
    const defaultFilter = canHandleSupportTickets() ? 'open' : 'mine';
    const s = attrs && attrs.status;
    if (!s) return defaultFilter;
    for (let i = 0; i < FILTER_OPTIONS.length; i++) {
      if (FILTER_OPTIONS[i].id === s) return s;
    }
    return defaultFilter;
  }

  _load(quiet = false, freshSearch = false) {
    // A quiet reload keeps the current list on screen instead of a spinner.
    if (!quiet) {
      this.loading = true;
      m.redraw();
    }

    // A quiet (live) reload refetches everything already on screen, so a list
    // the viewer has paged through does not snap back to the first page.
    const limit = quiet && !freshSearch ? Math.min(100, Math.max(PAGE_SIZE, this.tickets.length)) : PAGE_SIZE;
    const seq = ++this._loadSeq;

    loadTickets(this._params(0, limit))
      .then((tickets: any) => {
        if (seq !== this._loadSeq) return;
        this.tickets = tickets || [];
        this.hasMore = !!(tickets && tickets.payload && tickets.payload.links && tickets.payload.links.next);
        this.loading = false;
        m.redraw();
      })
      .catch((err: any) => {
        if (seq !== this._loadSeq) return;
        this.error = err;
        this.loading = false;
        console.error('[linkrobins/support] index load failed:', err);
        m.redraw();
      });
  }

  _loadMore() {
    if (this.loadingMore) return;
    this.loadingMore = true;
    m.redraw();

    loadTickets(this._params(this.tickets.length, PAGE_SIZE))
      .then((more: any) => {
        // Skip anything already shown, in case the list shifted between pages.
        const seen = new Set(this.tickets.map((t: any) => String(t.id())));
        this.tickets = this.tickets.concat((more || []).filter((t: any) => !seen.has(String(t.id()))));
        this.hasMore = !!(more && more.payload && more.payload.links && more.payload.links.next);
        this.loadingMore = false;
        m.redraw();
      })
      .catch((err: any) => {
        this.loadingMore = false;
        console.error('[linkrobins/support] load more tickets failed:', err);
        showError(tr('errors.load_more_tickets', 'Could not load more tickets.'));
        m.redraw();
      });
  }

  _params(offset: number, limit: number) {
    const filter: any = {};
    if (canHandleSupportTickets() && this.filter !== 'mine') {
      if (this.filter === 'assigned_to_me' || this.filter === 'unassigned') {
        // Work queues: what is still to be done, so closed tickets drop out.
        filter.assigned = this.filter === 'assigned_to_me' ? 'me' : 'none';
        filter['-status'] = 'closed';
      } else if (this.filter && this.filter !== 'all') {
        filter.status = this.filter;
      }
    } else {
      filter.mine = '1';
    }
    if (this.query.trim()) {
      filter.q = this.query.trim();
    }
    const params: any = { page: { offset, limit } };
    if (Object.keys(filter).length) {
      params.filter = filter;
    }
    return params;
  }

  view() {
    const content = m('div', { className: 'LinkRobinsSupport-container' }, [this._renderHeader(), this._renderList()]);

    return m(
      PageStructure,
      {
        className: 'IndexPage LinkRobinsSupport-page',
        sidebar: () => this._renderSidebar(),
      },
      content
    );
  }

  _renderSidebar() {
    try {
      return m(SupportIndexSidebar, {
        className: 'LinkRobinsSupport-sidebar',
        activeFilter: this.filter,
      });
    } catch (e) {
      console.error('[linkrobins/support] sidebar render failed:', e);
    }
    return null;
  }

  _renderHeader() {
    const label = this._headingFor(this.filter);
    return m('header', { className: 'LinkRobinsSupport-header LinkRobinsSupport-indexHeader' }, [
      m('h1', { className: 'LinkRobinsSupport-title' }, [m('i', { className: 'fas fa-life-ring' }), ' ', label]),
      this._renderSearch(),
    ]);
  }

  /**
   * Search the current view by subject, reply text or ticket number. Typing
   * reloads after a short pause rather than on every key.
   */
  _renderSearch() {
    return m('div', { className: 'LinkRobinsSupport-search' }, [
      m('i', { className: 'fas fa-search LinkRobinsSupport-search-icon', 'aria-hidden': 'true' }),
      m('input', {
        className: 'FormControl LinkRobinsSupport-search-input',
        type: 'search',
        value: this.query,
        placeholder: trText('index.search_placeholder', 'Search tickets'),
        'aria-label': trText('index.search_placeholder', 'Search tickets'),
        oninput: (e: any) => {
          this.query = e.target.value;
          clearTimeout(this._searchTimer);
          this._searchTimer = setTimeout(() => this._load(true, true), 300);
        },
      }),
    ]);
  }

  _headingFor(filter: string | null) {
    if (!filter || filter === 'mine') return tr('nav', 'Support');
    for (let i = 0; i < FILTER_OPTIONS.length; i++) {
      if (FILTER_OPTIONS[i].id === filter) return filterLabel(FILTER_OPTIONS[i]);
    }
    return tr('nav', 'Support');
  }

  _renderList() {
    if (this.loading) {
      return m(LoadingIndicator);
    }
    if (this.error) {
      return m('div', { className: 'LinkRobinsSupport-empty' }, tr('errors.load_tickets', 'Could not load tickets.'));
    }
    if (!this.tickets.length && this.query.trim()) {
      return m('div', { className: 'LinkRobinsSupport-empty' }, tr('index.no_results', 'No tickets match your search.'));
    }
    if (!this.tickets.length) {
      return m('div', { className: 'LinkRobinsSupport-empty' }, emptyLabel(this.filter, canCreateSupportTicket()));
    }
    return [
      m(
        'div',
        { className: 'LinkRobinsSupport-list' },
        this.tickets.map((t: any) => this._renderRow(t))
      ),
      // Exactly how core's discussion list does it: its container class (so
      // core's styling applies), a plain button with core's own "Load More"
      // wording, swapped for a spinner while the next page loads.
      this.hasMore || this.loadingMore
        ? m(
            'div',
            { className: 'DiscussionList-loadMore' },
            this.loadingMore
              ? m(LoadingIndicator)
              : m(
                  Button,
                  { className: 'Button', onclick: () => this._loadMore() },
                  app.translator.trans('core.forum.discussion_list.load_more_button')
                )
          )
        : null,
    ];
  }

  /**
   * Who has the ticket, for staff scanning the queue, as a chip under the
   * status: their avatar and name, or "Unassigned". It sits apart from the
   * meta line so it is never mistaken for the person who opened the ticket.
   * Members see only their own tickets and do not need routing detail.
   */
  _renderAssignee(ticket: any) {
    if (!canHandleSupportTickets()) return null;
    const assignee = ticket.assignedStaff && ticket.assignedStaff();
    if (!assignee) {
      return m('span', { className: 'LinkRobinsSupport-chip LinkRobinsSupport-chip--assignee is-unassigned' }, [
        m('i', { className: 'fas fa-user-slash', 'aria-hidden': 'true' }),
        tr('index.unassigned', 'Unassigned'),
      ]);
    }
    const name = assignee.displayName() || assignee.username();
    return m(
      'span',
      { className: 'LinkRobinsSupport-chip LinkRobinsSupport-chip--assignee', title: trText('index.assigned_to', 'Assigned to {name}', { name }) },
      [m(Avatar, { user: assignee }), name]
    );
  }

  badgeItems(ticket: any): ItemList<any> {
    const items = new ItemList<any>();
    const cat = ticket.category && ticket.category();
    if (cat) {
      const driver = ticketTypes.forCategory(cat);
      if (driver && driver.badgeItems) {
        driver.badgeItems(items, ticket);
      }
    }
    return items;
  }

  _renderRow(ticket: any) {
    const user = ticket.user && ticket.user();
    const cat = ticket.category && ticket.category();
    const href = basePath() + BASE_PATH + '/' + encodeURIComponent(ticket.id());
    const isDeleted = !!(ticket.isDeleted && ticket.isDeleted());
    const isUnread = !!(ticket.isUnread && ticket.isUnread());

    return m(
      'a',
      {
        href,
        className: 'LinkRobinsSupport-row' + (isDeleted ? ' LinkRobinsSupport-row--deleted' : '') + (isUnread ? ' is-unread' : ''),
        onclick: (e: any) => {
          safeNavigate(href, e);
        },
        key: 'ticket-' + ticket.id(),
      },
      [
        m('div', { className: 'LinkRobinsSupport-row-main' }, [
          m('div', { className: 'LinkRobinsSupport-row-subject' }, [
            isUnread
              ? m('span', {
                  className: 'LinkRobinsSupport-unreadDot',
                  title: trText('index.unread', 'New replies'),
                  'aria-label': trText('index.unread', 'New replies'),
                })
              : null,
            ticket.subject() || tr('index.untitled', 'Untitled'),
            isDeleted ? m('span', { className: 'LinkRobinsSupport-row-deletedBadge' }, tr('index.deleted_badge', 'Deleted')) : null,
          ]),
          m('div', { className: 'LinkRobinsSupport-row-meta' }, [
            cat
              ? m('span', { className: 'LinkRobinsSupport-row-cat' }, [
                  m('span', { className: 'LinkRobinsSupport-chip-dot', style: { background: cat.color() || 'var(--muted-color)' } }),
                  cat.name(),
                ])
              : null,
            user ? m('span', { className: 'LinkRobinsSupport-row-user' }, user.displayName() || user.username()) : null,
            m('span', { className: 'LinkRobinsSupport-row-date' }, formatDate(ticket.lastReplyAt() || ticket.createdAt())),
          ]),
        ]),
        m('div', { className: 'LinkRobinsSupport-row-side' }, [
          canHandleSupportTickets() ? priorityChip(ticket.priority && ticket.priority()) : null,
          this.badgeItems(ticket).toArray(),
          statusChip(ticket.status()),
          this._renderAssignee(ticket),
        ]),
      ]
    );
  }
}
