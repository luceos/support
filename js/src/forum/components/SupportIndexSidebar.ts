import IndexSidebar from 'flarum/forum/components/IndexSidebar';
import LinkButton from 'flarum/common/components/LinkButton';
import Button from 'flarum/common/components/Button';
import SelectDropdown from 'flarum/common/components/SelectDropdown';
import ItemList from 'flarum/common/utils/ItemList';
import Separator from 'flarum/common/components/Separator';
import { tr } from '../utils/translate';
import { basePath, BASE_PATH, safeNavigate, showForumNavOnSupportPages } from '../utils/helpers';
import { canCreateSupportTicket, canHandleSupportTickets } from '../utils/permissions';
import { FILTER_OPTIONS, filterLabel, filterHrefFor } from '../utils/status';
import { refreshCounts, supportCount, COUNT_FOR_FILTER } from '../utils/counts';
import { onLive, throttleLive, LiveThrottle } from '../utils/live';
import SupportStatsModal from './SupportStatsModal';

/**
 * The views menu. Core's SelectDropdown labels its button with the active
 * item's own children, so the very same vnodes are rendered twice: once in
 * the menu, once in the button. Ours carry a count badge that appears,
 * changes and disappears as tickets move, and a vnode rendered in two places
 * cannot be diffed: Mithril tries to remove the badge from the button using
 * the menu's copy of it, and throws "removeChild: The node to be removed is
 * not a child of this node" on every status change.
 *
 * So the button is labelled from defaultLabel instead, which the sidebar
 * builds fresh on each render from the active view's name (no badge).
 */
class SupportViewsDropdown extends SelectDropdown<any> {
  getButtonContent(children: any) {
    return super.getButtonContent([]);
  }
}

export default class SupportIndexSidebar extends IndexSidebar<any> {
  _stopLive: (() => void) | null = null;
  _liveCounts: LiveThrottle | null = null;

  oncreate(vnode: any) {
    super.oncreate(vnode);
    refreshCounts();
    const counts = throttleLive(refreshCounts);
    this._liveCounts = counts;
    this._stopLive = onLive(() => counts.call());
  }

  onremove(vnode: any) {
    if (this._stopLive) this._stopLive();
    this._stopLive = null;
    if (this._liveCounts) this._liveCounts.cancel();
    this._liveCounts = null;
    super.onremove(vnode);
  }

  items() {
    const items = new ItemList();

    // "New ticket" primary button -- mirrors the blog's "Compose" button.
    if (canCreateSupportTicket()) {
      const newHref = basePath() + BASE_PATH + '/new';
      items.add(
        'newTicket',
        m(
          Button,
          {
            icon: 'fas fa-plus',
            className: 'Button Button--primary LinkRobinsSupport-newTicketButton',
            itemClassName: 'App-primaryControl',
            'aria-label': tr('index.new_ticket', 'New ticket'),
            title: tr('index.new_ticket_tooltip', 'Open a new support ticket'),
            onclick: (e: any) => {
              safeNavigate(newHref, e);
            },
          },
          tr('index.new_ticket', 'New ticket')
        ),
        110
      );
    }

    const active = FILTER_OPTIONS.find((opt) => opt.id === this._activeFilter());

    items.add(
      'nav',
      m(
        SupportViewsDropdown,
        {
          buttonClassName: 'Button',
          className: 'App-titleControl',
          defaultLabel: active ? filterLabel(active) : tr('nav', 'Support'),
        },
        this.navItems().toArray()
      ),
      90
    );

    return items;
  }

  /**
   * The support filters, and the forum's own navigation above them only if an
   * admin has asked for it.
   *
   * This subclasses IndexSidebar, so super.navItems() carries the forum's
   * navigation (All Discussions, Following, the Tags block) into the support
   * sidebar. Off by default, because support pages are for the tickets
   * somebody came here for; starting from an empty list also means an
   * extension that adds itself to IndexSidebar cannot reappear here.
   */
  navItems() {
    const items = showForumNavOnSupportPages() ? this.forumNavItems() : new ItemList();

    const canHandle = canHandleSupportTickets();
    const currentFilter = this._activeFilter();

    // Only worth a divider when there is something above to divide from.
    if (showForumNavOnSupportPages()) {
      items.add('linkrobinsSupportSeparator', m(Separator), -20);
    }

    FILTER_OPTIONS.forEach((opt, i) => {
      if (opt.staffOnly && !canHandle) return;
      items.add(
        'support-filter-' + opt.id,
        m(
          LinkButton,
          {
            href: filterHrefFor(opt.id),
            icon: opt.icon,
            active: currentFilter === opt.id,
          },
          [filterLabel(opt), this._count(opt.id)]
        ),
        -21 - i
      );
    });

    // Support stats for staff, after the views. A button, since it opens a
    // modal over the current list rather than going anywhere.
    if (canHandle) {
      items.add(
        'support-stats',
        m(
          Button,
          { icon: 'fas fa-chart-bar', className: 'LinkButton LinkRobinsSupport-statsLink', onclick: () => app.modal.show(SupportStatsModal) },
          tr('stats.title', 'Support stats')
        ),
        -21 - FILTER_OPTIONS.length
      );
    }

    return items;
  }

  /** The view being shown: 'mine' by default, null when none is (a ticket page). */
  _activeFilter(): string | null {
    return this.attrs && Object.prototype.hasOwnProperty.call(this.attrs, 'activeFilter') ? this.attrs.activeFilter : 'mine';
  }

  /**
   * The number beside a filter: open work for staff queues and statuses,
   * unread tickets beside "My tickets". Nothing when it is zero.
   */
  _count(filterId: string) {
    const key = COUNT_FOR_FILTER[filterId];
    const n = key ? supportCount(key) : 0;
    if (!n) return null;
    return m('span', { className: 'LinkRobinsSupport-navCount' + (filterId === 'mine' ? ' is-unread' : '') }, n > 99 ? '99+' : String(n));
  }

  /**
   * The forum's navigation, minus the per-tag clutter.
   *
   * The Tags extension injects the individual tags, a "More" link and a
   * separator into IndexSidebar.navItems. The top-level "Tags" link is kept so
   * there is still a way back to the tags page; the rest is noise beside a
   * ticket list.
   */
  forumNavItems() {
    let items;

    try {
      items = super.navItems();
    } catch (e) {
      console.warn('[linkrobins/support] super.navItems() threw, falling back:', e);
      items = new ItemList();
    }

    if (!items) return new ItemList();

    try {
      const all = (items as any)._items || {};
      Object.keys(all).forEach((key) => {
        // Our own Support link stays. It points at the page it is already on,
        // which is exactly what All Discussions does on the index: Flarum marks
        // the current one active, and dropping it would make the navigation
        // change shape depending on which page you are looking at.
        if (key === 'moreTags' || key === 'separator' || /^tag\d+$/.test(key)) {
          if (typeof items.remove === 'function') items.remove(key);
        }
      });
    } catch (e) {}

    return items;
  }
}
