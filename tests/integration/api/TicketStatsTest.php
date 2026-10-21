<?php

/*
 * This file is part of linkrobins/support.
 *
 * For detailed copyright and license information, please view the
 * LICENSE file that was distributed with this source code.
 */

namespace LinkRobins\Support\Tests\integration\api;

use Carbon\Carbon;
use Flarum\Testing\integration\RetrievesAuthorizedUsers;
use Flarum\Testing\integration\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * The staff Stats page's numbers, against a small known history.
 */
class TicketStatsTest extends TestCase
{
    use RetrievesAuthorizedUsers;

    public function setUp(): void
    {
        parent::setUp();

        $this->extension('linkrobins-support');

        $base = Carbon::now()->subDays(5)->startOfHour();
        $at = fn (int $hours) => $base->copy()->addHours($hours);

        $this->prepareDatabase([
            'users' => [
                $this->normalUser(), // id 2
                ['id' => 3, 'username' => 'staffa', 'email' => 'staffa@machine.local', 'is_email_confirmed' => 1, 'password' => 'too-obscure'],
            ],
            'groups' => [
                ['id' => 100, 'name_singular' => 'Support', 'name_plural' => 'Support', 'is_hidden' => 0],
            ],
            'group_user' => [['user_id' => 3, 'group_id' => 100]],
            'group_permission' => [['group_id' => 100, 'permission' => 'lr-support.handle_tickets']],
            'linkrobins_support_categories' => [
                ['id' => 1, 'name' => 'General', 'slug' => 'general', 'ticket_type' => 'standard', 'position' => 0, 'created_at' => $base, 'updated_at' => $base],
            ],
            'linkrobins_support_tickets' => [
                // Answered in 2h, resolved at 10h, then confirmed solved by the owner.
                ['id' => 1, 'category_id' => 1, 'user_id' => 2, 'subject' => 'A', 'status' => 'closed', 'last_reply_at' => $at(2), 'created_at' => $at(0), 'updated_at' => $at(12)],
                // Answered in 4h, resolved at 20h, then auto-closed.
                ['id' => 2, 'category_id' => 1, 'user_id' => 2, 'subject' => 'B', 'status' => 'closed', 'last_reply_at' => $at(4), 'created_at' => $at(0), 'updated_at' => $at(30)],
                // Never answered, still open.
                ['id' => 3, 'category_id' => 1, 'user_id' => 2, 'subject' => 'C', 'status' => 'open', 'last_reply_at' => $at(0), 'created_at' => $at(0), 'updated_at' => $at(0)],
            ],
            'linkrobins_support_replies' => [
                ['id' => 1, 'ticket_id' => 1, 'user_id' => 2, 'content' => '<t>Help</t>', 'is_internal_note' => 0, 'created_at' => $at(0), 'updated_at' => $at(0)],
                ['id' => 2, 'ticket_id' => 1, 'user_id' => 3, 'content' => '<t>Note</t>', 'is_internal_note' => 1, 'created_at' => $at(1), 'updated_at' => $at(1)],
                ['id' => 3, 'ticket_id' => 1, 'user_id' => 3, 'content' => '<t>Answer</t>', 'is_internal_note' => 0, 'created_at' => $at(2), 'updated_at' => $at(2)],
                ['id' => 4, 'ticket_id' => 2, 'user_id' => 2, 'content' => '<t>Help</t>', 'is_internal_note' => 0, 'created_at' => $at(0), 'updated_at' => $at(0)],
                ['id' => 5, 'ticket_id' => 2, 'user_id' => 3, 'content' => '<t>Answer</t>', 'is_internal_note' => 0, 'created_at' => $at(4), 'updated_at' => $at(4)],
                ['id' => 6, 'ticket_id' => 3, 'user_id' => 2, 'content' => '<t>Help</t>', 'is_internal_note' => 0, 'created_at' => $at(0), 'updated_at' => $at(0)],
            ],
            'linkrobins_support_events' => [
                ['ticket_id' => 1, 'user_id' => 3, 'type' => 'status', 'from_status' => 'in_progress', 'to_status' => 'resolved', 'created_at' => $at(10)],
                ['ticket_id' => 1, 'user_id' => 2, 'type' => 'status', 'from_status' => 'resolved', 'to_status' => 'closed', 'created_at' => $at(12)],
                ['ticket_id' => 2, 'user_id' => 3, 'type' => 'status', 'from_status' => 'in_progress', 'to_status' => 'resolved', 'created_at' => $at(20)],
                ['ticket_id' => 2, 'user_id' => null, 'type' => 'status', 'from_status' => 'resolved', 'to_status' => 'closed', 'created_at' => $at(30)],
            ],
        ]);
    }

    private function stats(int $actor, array $query = []): array
    {
        $response = $this->send(
            $this->request('GET', '/api/linkrobins-support-stats', ['authenticatedAs' => $actor])->withQueryParams($query)
        );

        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)['data'] ?? null];
    }

    #[Test]
    public function members_cannot_see_stats(): void
    {
        [$status] = $this->stats(2);

        $this->assertEquals(403, $status);
    }

    #[Test]
    public function it_counts_volume_and_backlog(): void
    {
        [$status, $data] = $this->stats(3);

        $this->assertEquals(200, $status);
        $this->assertEquals(30, $data['days']);
        $this->assertEquals(3, $data['opened']);
        $this->assertEquals(2, $data['closed']);
        $this->assertEquals(1, $data['backlog']['waiting']);
        $this->assertEquals(1, $data['backlog']['olderThan3Days']);
        $this->assertEquals(0, $data['backlog']['olderThan7Days']);
        $this->assertEquals(3, array_sum(array_column($data['volume'], 'opened')));
    }

    #[Test]
    public function first_response_ignores_internal_notes_and_counts_unanswered(): void
    {
        [, $data] = $this->stats(3);

        // 2h and 4h: nearest-rank median is 2h, 90th percentile 4h.
        $this->assertEquals(2 * 3600, $data['firstResponse']['median']);
        $this->assertEquals(4 * 3600, $data['firstResponse']['p90']);
        $this->assertEquals(2, $data['firstResponse']['answered']);
        $this->assertEquals(1, $data['firstResponse']['unanswered']);
    }

    #[Test]
    public function time_to_resolve_and_how_tickets_ended(): void
    {
        [, $data] = $this->stats(3);

        $this->assertEquals(10 * 3600, $data['timeToResolve']['median']);
        $this->assertEquals(['confirmed' => 1, 'auto' => 1, 'staff' => 0], $data['endings']);
    }

    #[Test]
    public function the_per_staff_breakdown_credits_who_answered(): void
    {
        [, $data] = $this->stats(3);

        $this->assertCount(1, $data['staff']);
        $this->assertEquals('staffa', $data['staff'][0]['username']);
        $this->assertEquals(2, $data['staff'][0]['replies']);
        $this->assertEquals(2, $data['staff'][0]['firstResponses']);
    }

    #[Test]
    public function per_staff_counts_replies_and_distinct_tickets_for_each_member(): void
    {
        $at = Carbon::now()->subDays(2);
        $this->prepareDatabase([
            'users' => [
                ['id' => 4, 'username' => 'staffb', 'email' => 'staffb@machine.local', 'is_email_confirmed' => 1, 'password' => 'too-obscure'],
            ],
            'group_user' => [['user_id' => 4, 'group_id' => 100]],
            'linkrobins_support_replies' => [
                // staffa: two more public replies on ticket 1 (four public replies over two tickets in all).
                ['id' => 7, 'ticket_id' => 1, 'user_id' => 3, 'content' => '<t>More</t>', 'is_internal_note' => 0, 'created_at' => $at, 'updated_at' => $at],
                ['id' => 8, 'ticket_id' => 1, 'user_id' => 3, 'content' => '<t>More</t>', 'is_internal_note' => 0, 'created_at' => $at, 'updated_at' => $at],
                // staffb: three public replies on two tickets, plus a note that doesn't count.
                ['id' => 9, 'ticket_id' => 2, 'user_id' => 4, 'content' => '<t>Hi</t>', 'is_internal_note' => 0, 'created_at' => $at, 'updated_at' => $at],
                ['id' => 10, 'ticket_id' => 2, 'user_id' => 4, 'content' => '<t>Hi</t>', 'is_internal_note' => 0, 'created_at' => $at, 'updated_at' => $at],
                ['id' => 11, 'ticket_id' => 3, 'user_id' => 4, 'content' => '<t>Hi</t>', 'is_internal_note' => 0, 'created_at' => $at, 'updated_at' => $at],
                ['id' => 12, 'ticket_id' => 3, 'user_id' => 4, 'content' => '<t>Note</t>', 'is_internal_note' => 1, 'created_at' => $at, 'updated_at' => $at],
            ],
        ]);

        [, $data] = $this->stats(3);
        $byName = array_column($data['staff'], null, 'username');

        $this->assertSame(['staffa', 'staffb'], array_column($data['staff'], 'username'));
        $this->assertEquals(4, $byName['staffa']['replies']);
        $this->assertEquals(2, $byName['staffa']['tickets']);
        $this->assertEquals(3, $byName['staffb']['replies']);
        $this->assertEquals(2, $byName['staffb']['tickets']);
        // Ticket 3 had no answer before staffb's reply.
        $this->assertEquals(1, $byName['staffb']['firstResponses']);
    }

    #[Test]
    public function an_unknown_window_falls_back_to_thirty_days(): void
    {
        [, $data] = $this->stats(3, ['days' => '365']);

        $this->assertEquals(30, $data['days']);
    }
}
