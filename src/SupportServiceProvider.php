<?php

namespace LinkRobins\Support;

use Carbon\Carbon;
use Flarum\Foundation\AbstractServiceProvider;
use Flarum\Formatter\Formatter;
use Flarum\User\User;
use Illuminate\Contracts\Bus\Dispatcher;
use Illuminate\Contracts\Events\Dispatcher as Events;
use LinkRobins\Support\Access\SupportAbilities;
use LinkRobins\Support\Event\ReplyCreated;
use LinkRobins\Support\Event\ReplyPosted;
use LinkRobins\Support\Event\TicketAssigned;
use LinkRobins\Support\Event\TicketChanged;
use LinkRobins\Support\Event\TicketCreated;
use LinkRobins\Support\Event\TicketDecided;
use LinkRobins\Support\Event\TicketStatusChanged;
use LinkRobins\Support\Job\NotifyNewReply;
use LinkRobins\Support\Job\NotifyNewTicket;
use LinkRobins\Support\TicketType\TicketTypeManager;
use Psr\Log\LoggerInterface;

class SupportServiceProvider extends AbstractServiceProvider
{
    public function register(): void
    {
        $this->container->singleton(TicketTypeManager::class, function ($container) {
            return new TicketTypeManager($container);
        });
    }

    public function boot(Formatter $formatter, Dispatcher $bus, Events $events, LoggerInterface $log): void
    {
        // Plug Flarum's formatter into the reply model so calling
        // setContentAttribute() runs Markdown/BBCode through the same
        // pipeline discussions use. The parsed source ends up in
        // `content`; rendered HTML is produced on demand via
        // formatContent() at serialize time (no content_html column).
        SupportReply::setFormatter($formatter);

        // Bump the parent ticket's last_reply_at whenever a reply is
        // created, advance status per the rules below, and dispatch a
        // notification to the appropriate party.
        //
        // Status rules:
        //   - If a staff member replies to an `open` ticket, mark it
        //     `in_progress`.
        //   - If the creator replies to an `awaiting_user` ticket, flip
        //     it back to `in_progress` (creator answered the question).
        //   - If anyone replies to a `resolved` ticket, reopen it to
        //     `in_progress`. Closed tickets reject replies at the policy
        //     level, so we never see them here.
        SupportReply::created(function (SupportReply $reply) use ($bus, $events, $log) {
            try {
                $ticket = $reply->ticket;
                if (! $ticket) {
                    return;
                }
                $ticket->last_reply_at = Carbon::now();

                $isStaff = static::actorIsStaff($reply->user);
                $isOpening = static::isOpeningMessage($reply);

                if (! $reply->is_internal_note) {
                    if ($ticket->status === SupportTicket::STATUS_RESOLVED) {
                        $ticket->status = SupportTicket::STATUS_IN_PROGRESS;
                    } elseif ($isStaff && $ticket->status === SupportTicket::STATUS_OPEN) {
                        $ticket->status = SupportTicket::STATUS_IN_PROGRESS;
                    } elseif (! $isStaff && $ticket->status === SupportTicket::STATUS_AWAITING_USER) {
                        $ticket->status = SupportTicket::STATUS_IN_PROGRESS;
                    }
                }

                // Auto-claim the ticket when a staff member replies on a
                // currently-unassigned ticket. The replier becomes the
                // assignee. We deliberately do NOT override an existing
                // assignment -- if Alice is handling the ticket and Bob
                // chimes in with a single reply, the ticket stays Alice's.
                // That handles the "second pair of eyes" case where one
                // staff member is the owner and another pitches in for one
                // comment without taking it over.
                //
                // Internal notes also trigger auto-claim, on the theory
                // that if you're posting an internal note about a
                // currently-unowned ticket, you're effectively picking it
                // up. (The status-bump logic above intentionally skips
                // internal notes, but assignment is independent of status:
                // the status reflects the user-visible state of the
                // conversation, while assignment is staff routing.)
                if ($isStaff && $reply->user_id && ! $ticket->assigned_staff_id) {
                    $ticket->assigned_staff_id = $reply->user_id;
                }

                // The reply's author is who moved the status or claimed the
                // ticket, as far as the ticket timeline is concerned.
                $ticket->eventActor = $reply->relationLoaded('user') ? $reply->user : null;
                $ticket->eventActorId = $reply->user_id ? (int) $reply->user_id : null;
                // Any status move here comes from the rules above, not a
                // choice the author made, so the timeline says it happened
                // automatically.
                $ticket->eventAutomatic = true;
                $ticket->savingOpeningMessage = $isOpening;
                $ticket->save();
                $ticket->savingOpeningMessage = false;
                $ticket->eventAutomatic = false;

                static::afterCommit(fn () => $events->dispatch(new ReplyPosted($reply, $reply->user)));

                // The opening message is announced by TicketCreated.
                if (! $isOpening) {
                    static::afterCommit(fn () => $events->dispatch(new ReplyCreated($reply, $reply->user)));
                }

                // Notifications: dispatched only for user-facing replies.
                // Internal notes are staff coordination -- the ticket
                // owner shouldn't see they exist.
                //
                // The opening message is also a reply (the ticket resource
                // posts it through SupportReplyResource so it gets the same
                // validation and formatting as any other), but it is already
                // covered by the new-ticket notification. Without this guard
                // every new ticket sent staff two alerts and two emails for
                // the same words -- and, now that a category can route its
                // tickets to one person, the reply notification would go to
                // the whole staff list and undo that routing.
                if (! $reply->is_internal_note && ! $isOpening) {
                    static::afterCommit(fn () => $bus->dispatch(new NotifyNewReply($reply->id)));
                }
            } catch (\Throwable $e) {
                $log->warning('[linkrobins/support] reply post-save hook failed', ['exception' => $e]);
            }
        });

        // When a ticket is opened, notify staff so they can pick it up.
        // The actor themselves is excluded so a staff member filing a
        // ticket doesn't get notified about their own ticket.
        SupportTicket::created(function (SupportTicket $ticket) use ($bus, $events, $log) {
            try {
                // After the commit: on the sync queue this keeps staff emails
                // out of the create transaction (and its user row lock); on an
                // async queue it stops a worker loading the ticket too early.
                static::afterCommit(fn () => $bus->dispatch(new NotifyNewTicket($ticket->id)));
                static::afterCommit(fn () => $events->dispatch(new TicketChanged($ticket, $ticket->user)));
                // After the commit, which on the API's create path is after
                // the opening message is saved too.
                static::afterCommit(fn () => $events->dispatch(new TicketCreated($ticket, $ticket->user)));
            } catch (\Throwable $e) {
                $log->warning('[linkrobins/support] ticket post-save hook failed', ['exception' => $e]);
            }
        });

        // Stamp when the status last changed. Auto-close counts a resolved
        // ticket's quiet period from here (see CloseResolvedTicketsCommand).
        SupportTicket::saving(function (SupportTicket $ticket) {
            if (! $ticket->exists || $ticket->isDirty('status')) {
                $ticket->status_changed_at = Carbon::now();
            }
        });

        // Record status and assignment changes for the ticket timeline, then
        // tell anyone listening (flarum/realtime) that the ticket moved. This
        // is a model event rather than an API hook on purpose: replies and the
        // auto-close command change status without going through the API,
        // and their changes belong in the history too. A failure here is
        // logged rather than thrown, so the save itself always stands.
        SupportTicket::updated(function (SupportTicket $ticket) use ($events, $log) {
            try {
                SupportEvent::recordChanges($ticket);
            } catch (\Throwable $e) {
                $log->warning('[linkrobins/support] could not record ticket history', ['exception' => $e]);
            }

            try {
                $actor = $ticket->eventActor;
                if (! $actor && $ticket->eventActorId) {
                    if ($ticket->relationLoaded('user') && $ticket->user && (int) $ticket->user->id === (int) $ticket->eventActorId) {
                        $actor = $ticket->user;
                    } elseif ($ticket->relationLoaded('assignedStaff') && $ticket->assignedStaff && (int) $ticket->assignedStaff->id === (int) $ticket->eventActorId) {
                        $actor = $ticket->assignedStaff;
                    } else {
                        $actor = User::query()->find($ticket->eventActorId);
                    }
                }

                foreach (static::lifecycleEvents($ticket, $actor, $log) as $event) {
                    static::afterCommit(fn () => $events->dispatch($event));
                }

                static::afterCommit(fn () => $events->dispatch(new TicketChanged($ticket, $actor)));
            } catch (\Throwable $e) {
                $log->warning('[linkrobins/support] ticket change event failed', ['exception' => $e]);
            }
        });
    }

    /**
     * Run $callback once the surrounding transaction commits, or now if there
     * is none.
     *
     * Opening a ticket writes the ticket and its first reply in one
     * transaction. A listener that queues work (flarum/realtime does) could
     * otherwise run before the commit and find no ticket to load. Core binds
     * the transactions manager this needs; the fallback covers a release
     * candidate that predates that, where dispatching straight away is the
     * old behaviour.
     */
    /**
     * The specific events for what this save changed, for other extensions to
     * listen to (webhooks, bots, audit logs). Built here, from the model, so
     * every route that changes a ticket is covered: the API, a reply moving
     * the status on or claiming the ticket, and the auto-close command.
     *
     * Called from the updated hook, where getOriginal() still holds the values
     * from before the save.
     *
     * @return list<object>
     */
    protected static function lifecycleEvents(SupportTicket $ticket, ?User $actor, LoggerInterface $log): array
    {
        if ($ticket->savingOpeningMessage) {
            return [];
        }

        $changes = $ticket->getChanges();
        $events = [];

        if (array_key_exists('status', $changes) && $ticket->getOriginal('status') !== $changes['status']) {
            $oldStatus = $ticket->getOriginal('status');
            $newStatus = (string) $changes['status'];
            $events[] = new TicketStatusChanged($ticket, $actor, $oldStatus, $newStatus);

            $category = $ticket->currentCategory();
            if ($category) {
                static::afterCommit(function () use ($category, $ticket, $newStatus, $oldStatus, $actor, $log) {
                    try {
                        $category->ticketType()->onStatusChanged($ticket, $newStatus, $oldStatus, $actor);
                    } catch (\Throwable $e) {
                        $log->error('[linkrobins/support] ticket type onStatusChanged failed', ['exception' => $e]);
                    }
                });
            }
        }

        if (array_key_exists('decision', $changes) && $ticket->getOriginal('decision') !== $changes['decision']) {
            $oldDecision = $ticket->getOriginal('decision');
            $newDecision = (string) $changes['decision'];
            $events[] = new TicketDecided($ticket, $actor, $oldDecision, $newDecision);

            $category = $ticket->currentCategory();
            if ($category) {
                static::afterCommit(function () use ($category, $ticket, $newDecision, $oldDecision, $actor, $log) {
                    try {
                        $category->ticketType()->onDecided($ticket, $newDecision, $oldDecision, $actor);
                    } catch (\Throwable $e) {
                        $log->error('[linkrobins/support] ticket type onDecided failed', ['exception' => $e]);
                    }
                });
            }
        }

        if (array_key_exists('assigned_staff_id', $changes)) {
            $from = $ticket->getOriginal('assigned_staff_id');
            $to = $changes['assigned_staff_id'];
            $from = $from === null ? null : (int) $from;
            $to = $to === null ? null : (int) $to;

            if ($from !== $to) {
                // The actor is usually one of the two (claiming, or handing
                // over); reuse it rather than look them up again.
                $user = fn (?int $id) => $id === null ? null : (
                    $actor && (int) $actor->id === $id
                        ? $actor
                        : ($ticket->relationLoaded('user') && $ticket->user && (int) $ticket->user->id === $id
                            ? $ticket->user
                            : ($ticket->relationLoaded('assignedStaff') && $ticket->assignedStaff && (int) $ticket->assignedStaff->id === $id
                                ? $ticket->assignedStaff
                                : User::query()->find($id)))
                );
                $events[] = new TicketAssigned($ticket, $actor, $user($to), $user($from));
            }
        }

        return $events;
    }

    protected static function afterCommit(callable $callback): void
    {
        try {
            SupportTicket::query()->getConnection()->afterCommit($callback);
        } catch (\RuntimeException) {
            $callback();
        }
    }

    /**
     * Lightweight staff check used during the post-save hook where we
     * don't want to drag in the full policy machinery. Mirrors the
     * isStaff() helper in SupportTicketPolicy.
     */
    protected static function actorIsStaff(?User $user): bool
    {
        return $user !== null && SupportAbilities::isStaff($user);
    }

    /**
     * Whether this reply is the ticket's opening message.
     *
     * Determined by asking whether anything came before it rather than by a
     * flag the caller sets, so it holds however the reply was created -- the
     * ticket resource's createFirstReply() today, a seeder or an import
     * tomorrow. withTrashed() matters: if the real first reply has been
     * soft-deleted, the second one must not start counting as the opener and
     * lose its notification.
     */
    protected static function isOpeningMessage(SupportReply $reply): bool
    {
        return ! SupportReply::withTrashed()
            ->where('ticket_id', $reply->ticket_id)
            ->where('id', '<', $reply->id)
            ->exists();
    }
}
