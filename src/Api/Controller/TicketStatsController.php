<?php

namespace LinkRobins\Support\Api\Controller;

use Carbon\Carbon;
use Carbon\CarbonInterface;
use Flarum\Http\RequestUtil;
use Flarum\User\Exception\PermissionDeniedException;
use Flarum\User\User;
use Illuminate\Database\Eloquent\Collection as EloquentCollection;
use Illuminate\Support\Arr;
use Illuminate\Support\Collection;
use Laminas\Diactoros\Response\JsonResponse;
use LinkRobins\Support\Access\SupportAbilities;
use LinkRobins\Support\SupportEvent;
use LinkRobins\Support\SupportReply;
use LinkRobins\Support\SupportTicket;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * GET /api/linkrobins-support-stats?days=7|30|90: the staff Stats page.
 *
 * Everything is derived from what is already stored: tickets, replies and
 * the status history. Nothing new is tracked. Times are in seconds; the page
 * formats them. Staff only.
 *
 * Durations need history that only exists from the moment this version is
 * installed (status changes were not recorded before), so a window that
 * reaches back before the upgrade under-counts "time to resolve" and the
 * confirmed/auto-closed split until it fills up.
 */
class TicketStatsController implements RequestHandlerInterface
{
    public const WINDOWS = [7, 30, 90];

    /** Above this many tickets in a window, durations are computed from the most recent ones. */
    protected const SAMPLE_LIMIT = 5000;

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $actor = RequestUtil::getActor($request);

        if (! SupportAbilities::isStaff($actor)) {
            throw new PermissionDeniedException();
        }

        $days = (int) Arr::get($request->getQueryParams(), 'days', 30);
        if (! in_array($days, self::WINDOWS, true)) {
            $days = 30;
        }

        $now = Carbon::now();
        $since = $now->copy()->subDays($days);

        $staff = $this->staffMembers();
        $staffIds = array_keys($staff);

        $tickets = SupportTicket::query()
            ->where('created_at', '>=', $since)
            ->orderByDesc('created_at')
            ->limit(self::SAMPLE_LIMIT)
            ->get(['id', 'user_id', 'created_at']);
        $ticketIds = $tickets->pluck('id')->all();
        $owners = $tickets->pluck('user_id', 'id')->all();
        $openedAt = $tickets->mapWithKeys(fn (SupportTicket $t) => [$t->id => $t->created_at])->all();

        [$firstResponse, $firstResponder] = $this->firstResponses($ticketIds, $staffIds, $owners, $openedAt);
        $resolveTimes = $this->resolveTimes($ticketIds, $openedAt);
        $closes = $this->closes($since);

        return new JsonResponse(['data' => [
            'days' => $days,
            'opened' => $tickets->count(),
            'closed' => $closes->count(),
            'firstResponse' => [
                'median' => $this->percentile(array_values($firstResponse), 50),
                'p90' => $this->percentile(array_values($firstResponse), 90),
                'answered' => count($firstResponse),
                'unanswered' => $tickets->count() - count($firstResponse),
            ],
            'timeToResolve' => [
                'median' => $this->percentile(array_values($resolveTimes), 50),
                'p90' => $this->percentile(array_values($resolveTimes), 90),
                'resolved' => count($resolveTimes),
            ],
            'backlog' => $this->backlog($now),
            'endings' => $this->endings($closes),
            'volume' => $this->volume($tickets, $closes, $since, $now, $days),
            'staff' => $this->staffStats($staff, $since, $firstResponse, $firstResponder),
        ]]);
    }

    /**
     * Everyone who counts as staff, keyed by id.
     *
     * @return array<int, User>
     */
    protected function staffMembers(): array
    {
        $query = User::query();
        SupportAbilities::whereStaff($query);

        return $query->get(['id', 'username'])->keyBy('id')->all();
    }

    /**
     * First staff reply on each ticket opened in the window: seconds to it,
     * and who gave it, both keyed by ticket id. A staff member's own ticket
     * waits for someone else's answer. Read as plain rows (toBase keeps the
     * soft-delete scope): the sample can be thousands of replies and none of
     * them needs to be a model.
     *
     * @param list<int> $ticketIds
     * @param list<int> $staffIds
     * @param array<int, int|null> $owners
     * @param array<int, CarbonInterface|null> $openedAt
     * @return array{0: array<int, int>, 1: array<int, int>}
     */
    protected function firstResponses(array $ticketIds, array $staffIds, array $owners, array $openedAt): array
    {
        $firstResponse = [];
        $firstResponder = [];

        if (! $ticketIds || ! $staffIds) {
            return [$firstResponse, $firstResponder];
        }

        SupportReply::query()
            ->toBase()
            ->whereIn('ticket_id', $ticketIds)
            ->whereIn('user_id', $staffIds)
            ->where('is_internal_note', false)
            ->orderBy('created_at')
            ->get(['ticket_id', 'user_id', 'created_at'])
            ->each(function (object $reply) use (&$firstResponse, &$firstResponder, $owners, $openedAt) {
                $ticketId = (int) $reply->ticket_id;
                if (isset($firstResponse[$ticketId]) || (int) $reply->user_id === (int) ($owners[$ticketId] ?? 0)) {
                    return;
                }
                $firstResponse[$ticketId] = $this->seconds($openedAt[$ticketId] ?? null, Carbon::parse($reply->created_at));
                $firstResponder[$ticketId] = (int) $reply->user_id;
            });

        return [$firstResponse, $firstResponder];
    }

    /**
     * Seconds to the first move to resolved (or straight to closed) on each
     * ticket opened in the window, keyed by ticket id.
     *
     * @param list<int> $ticketIds
     * @param array<int, CarbonInterface|null> $openedAt
     * @return array<int, int>
     */
    protected function resolveTimes(array $ticketIds, array $openedAt): array
    {
        $resolveTimes = [];

        if (! $ticketIds) {
            return $resolveTimes;
        }

        SupportEvent::query()
            ->toBase()
            ->whereIn('ticket_id', $ticketIds)
            ->where('type', SupportEvent::TYPE_STATUS)
            ->whereIn('to_status', [SupportTicket::STATUS_RESOLVED, SupportTicket::STATUS_CLOSED])
            ->orderBy('created_at')
            ->get(['ticket_id', 'created_at'])
            ->each(function (object $event) use (&$resolveTimes, $openedAt) {
                $ticketId = (int) $event->ticket_id;
                if (! isset($resolveTimes[$ticketId])) {
                    $resolveTimes[$ticketId] = $this->seconds($openedAt[$ticketId] ?? null, Carbon::parse($event->created_at));
                }
            });

        return $resolveTimes;
    }

    /**
     * Closes in the window, for volume and for how tickets end. Not sampled,
     * since the closed total must be exact, so kept to plain rows with the
     * ticket owner joined in rather than a model and an eager-loaded ticket
     * per close. A trashed ticket has no owner here, as it had none through
     * the relation.
     *
     * @return Collection<int, \stdClass>
     */
    protected function closes(CarbonInterface $since): Collection
    {
        $events = (new SupportEvent())->getTable();
        $tickets = (new SupportTicket())->getTable();

        return SupportEvent::query()
            ->toBase()
            ->leftJoin($tickets, function ($join) use ($events, $tickets) {
                $join->on($tickets.'.id', '=', $events.'.ticket_id')
                    ->whereNull($tickets.'.deleted_at');
            })
            ->where($events.'.type', SupportEvent::TYPE_STATUS)
            ->where($events.'.to_status', SupportTicket::STATUS_CLOSED)
            ->where($events.'.created_at', '>=', $since)
            ->get([$events.'.user_id', $events.'.from_status', $events.'.created_at', $tickets.'.user_id as owner_id']);
    }

    /**
     * How resolved tickets were closed: confirmed by their owner, closed
     * automatically, or closed by staff.
     *
     * @param Collection<int, \stdClass> $closes
     * @return array{confirmed: int, auto: int, staff: int}
     */
    protected function endings(Collection $closes): array
    {
        $endings = ['confirmed' => 0, 'auto' => 0, 'staff' => 0];

        foreach ($closes as $close) {
            if ($close->from_status !== SupportTicket::STATUS_RESOLVED) {
                continue;
            }
            if ($close->user_id === null) {
                $endings['auto']++;
            } elseif ($close->owner_id !== null && (int) $close->user_id === (int) $close->owner_id) {
                $endings['confirmed']++;
            } else {
                $endings['staff']++;
            }
        }

        return $endings;
    }

    /**
     * Tickets opened and closed per period: days for a week, weeks otherwise.
     *
     * @param EloquentCollection<int, SupportTicket> $tickets
     * @param Collection<int, \stdClass> $closes
     * @return list<array{start: string, opened: int, closed: int}>
     */
    protected function volume(EloquentCollection $tickets, Collection $closes, CarbonInterface $since, CarbonInterface $now, int $days): array
    {
        $buckets = $this->buckets($since, $now, $days === 7 ? 'day' : 'week');
        $bucketKey = fn (CarbonInterface $at) => $days === 7 ? $at->copy()->startOfDay()->toDateString() : $at->copy()->startOfWeek()->toDateString();

        foreach ($tickets as $ticket) {
            $key = $bucketKey($ticket->created_at);
            if (isset($buckets[$key])) {
                $buckets[$key]['opened']++;
            }
        }
        foreach ($closes as $close) {
            $key = $bucketKey(Carbon::parse($close->created_at));
            if (isset($buckets[$key])) {
                $buckets[$key]['closed']++;
            }
        }

        return array_values($buckets);
    }

    /**
     * The current backlog, not limited to the window.
     *
     * @return array{waiting: int, olderThan3Days: int, olderThan7Days: int, unassigned: int}
     */
    protected function backlog(CarbonInterface $now): array
    {
        $waiting = fn () => SupportTicket::query()->whereIn('status', [
            SupportTicket::STATUS_OPEN,
            SupportTicket::STATUS_IN_PROGRESS,
            SupportTicket::STATUS_AWAITING_USER,
        ]);

        return [
            'waiting' => $waiting()->count(),
            'olderThan3Days' => $waiting()->where('created_at', '<=', $now->copy()->subDays(3))->count(),
            'olderThan7Days' => $waiting()->where('created_at', '<=', $now->copy()->subDays(7))->count(),
            'unassigned' => $waiting()->whereNull('assigned_staff_id')->count(),
        ];
    }

    /**
     * Per staff member, over the window, busiest first. Reply counts come
     * from the database: one row per staff member, however many replies the
     * window holds.
     *
     * @param array<int, User> $staff
     * @param array<int, int> $firstResponse
     * @param array<int, int> $firstResponder
     * @return list<array<string, mixed>>
     */
    protected function staffStats(array $staff, CarbonInterface $since, array $firstResponse, array $firstResponder): array
    {
        if (! $staff) {
            return [];
        }

        $perStaff = SupportReply::query()
            ->toBase()
            ->whereIn('user_id', array_keys($staff))
            ->where('is_internal_note', false)
            ->where('created_at', '>=', $since)
            ->groupBy('user_id')
            ->select('user_id')
            ->selectRaw('COUNT(*) as replies, COUNT(DISTINCT ticket_id) as tickets')
            ->get()
            ->keyBy('user_id');

        $people = [];
        foreach ($staff as $id => $member) {
            $mine = $perStaff->get($id);
            $responses = array_values(array_intersect_key($firstResponse, array_filter($firstResponder, fn ($who) => $who === $id)));
            if (! $mine && ! $responses) {
                continue;
            }
            $people[] = [
                'id' => (string) $id,
                'username' => $member->username,
                'displayName' => $member->display_name,
                'replies' => $mine ? (int) $mine->replies : 0,
                'tickets' => $mine ? (int) $mine->tickets : 0,
                'firstResponses' => count($responses),
                'medianFirstResponse' => $this->percentile($responses, 50),
            ];
        }
        usort($people, fn ($a, $b) => $b['replies'] <=> $a['replies']);

        return $people;
    }

    protected function seconds(?CarbonInterface $from, ?CarbonInterface $to): int
    {
        if (! $from || ! $to) {
            return 0;
        }

        return max(0, $to->getTimestamp() - $from->getTimestamp());
    }

    /**
     * Nearest-rank percentile; null when there is nothing to measure.
     *
     * @param list<int> $values
     */
    protected function percentile(array $values, int $percent): ?int
    {
        if (! $values) {
            return null;
        }
        sort($values);
        $rank = (int) ceil($percent / 100 * count($values));

        return $values[max(0, $rank - 1)];
    }

    /**
     * Empty periods from $since to $now, keyed by their start date, so the
     * chart shows quiet weeks as zero rather than leaving them out.
     *
     * @return array<string, array{start: string, opened: int, closed: int}>
     */
    protected function buckets(CarbonInterface $since, CarbonInterface $now, string $unit): array
    {
        $cursor = $unit === 'day' ? $since->copy()->startOfDay() : $since->copy()->startOfWeek();
        $out = [];
        while ($cursor <= $now) {
            $key = $cursor->toDateString();
            $out[$key] = ['start' => $key, 'opened' => 0, 'closed' => 0];
            $cursor = $unit === 'day' ? $cursor->copy()->addDay() : $cursor->copy()->addWeek();
        }

        return $out;
    }
}
