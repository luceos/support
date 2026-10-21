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
use LinkRobins\Support\SupportTicket;
use PHPUnit\Framework\Attributes\Test;

/**
 * A category's ticket count is stored, not counted on read. The rules worth
 * guarding: every way a ticket enters or leaves a category moves the count,
 * soft-deleted tickets don't count, and only category managers see it.
 */
class CategoryTicketCountTest extends TestCase
{
    use RetrievesAuthorizedUsers;

    public function setUp(): void
    {
        parent::setUp();

        $this->extension('linkrobins-support');

        $this->prepareDatabase([
            'users' => [
                $this->normalUser(), // id 2
            ],
            'linkrobins_support_categories' => [
                ['id' => 1, 'name' => 'General', 'slug' => 'general', 'ticket_type' => 'standard', 'position' => 0, 'created_at' => Carbon::now(), 'updated_at' => Carbon::now()],
                ['id' => 2, 'name' => 'Billing', 'slug' => 'billing', 'ticket_type' => 'standard', 'position' => 1, 'created_at' => Carbon::now(), 'updated_at' => Carbon::now()],
            ],
        ]);
    }

    private function ticketCount(int $categoryId): int
    {
        return (int) $this->database()->table('linkrobins_support_categories')->where('id', $categoryId)->value('ticket_count');
    }

    private function createTicket(): int
    {
        $response = $this->send(
            $this->request('POST', '/api/linkrobins-support-tickets', [
                'authenticatedAs' => 2,
                'json' => ['data' => [
                    'attributes' => ['subject' => 'Help', 'firstPost' => 'Please help.'],
                    'relationships' => ['category' => ['data' => ['type' => 'linkrobins-support-categories', 'id' => '1']]],
                ]],
            ])
        );
        $this->assertEquals(201, $response->getStatusCode(), (string) $response->getBody());

        return (int) json_decode((string) $response->getBody(), true)['data']['id'];
    }

    /** @param array<string, mixed> $data */
    private function patchTicket(int $id, array $data): void
    {
        $response = $this->send(
            $this->request('PATCH', '/api/linkrobins-support-tickets/'.$id, [
                'authenticatedAs' => 1,
                'json' => ['data' => ['type' => 'linkrobins-support-tickets', 'id' => (string) $id] + $data],
            ])
        );
        $this->assertEquals(200, $response->getStatusCode(), (string) $response->getBody());
    }

    #[Test]
    public function the_count_follows_a_ticket_through_its_lifecycle(): void
    {
        $id = $this->createTicket();
        $this->assertSame(1, $this->ticketCount(1));
        $this->assertSame(0, $this->ticketCount(2));

        $this->patchTicket($id, ['relationships' => ['category' => ['data' => ['type' => 'linkrobins-support-categories', 'id' => '2']]]]);
        $this->assertSame(0, $this->ticketCount(1));
        $this->assertSame(1, $this->ticketCount(2));

        $this->patchTicket($id, ['attributes' => ['isDeleted' => true]]);
        $this->assertSame(0, $this->ticketCount(2));

        $this->patchTicket($id, ['attributes' => ['isDeleted' => false]]);
        $this->assertSame(1, $this->ticketCount(2));

        $this->app();
        SupportTicket::query()->findOrFail($id)->forceDelete();
        $this->assertSame(0, $this->ticketCount(2));
    }

    #[Test]
    public function the_backfill_counts_existing_live_tickets(): void
    {
        $now = Carbon::now();
        $this->prepareDatabase([
            'linkrobins_support_tickets' => [
                ['id' => 1, 'category_id' => 1, 'user_id' => 2, 'subject' => 'A', 'status' => 'open', 'created_at' => $now, 'updated_at' => $now],
                ['id' => 2, 'category_id' => 1, 'user_id' => 2, 'subject' => 'B', 'status' => 'closed', 'created_at' => $now, 'updated_at' => $now],
                ['id' => 3, 'category_id' => 1, 'user_id' => 2, 'subject' => 'C', 'status' => 'open', 'created_at' => $now, 'updated_at' => $now, 'deleted_at' => $now],
                ['id' => 4, 'category_id' => 2, 'user_id' => 2, 'subject' => 'D', 'status' => 'open', 'created_at' => $now, 'updated_at' => $now],
            ],
        ]);

        $migration = require __DIR__.'/../../../migrations/2026_10_21_000002_backfill_ticket_count_on_support_categories.php';
        $migration['up']($this->database()->getSchemaBuilder());

        $this->assertSame(2, $this->ticketCount(1));
        $this->assertSame(1, $this->ticketCount(2));
    }

    #[Test]
    public function only_category_managers_see_the_count(): void
    {
        $this->createTicket();

        $as = function (?int $actor): array {
            $response = $this->send($this->request('GET', '/api/linkrobins-support-categories', $actor ? ['authenticatedAs' => $actor] : []));
            $this->assertEquals(200, $response->getStatusCode(), (string) $response->getBody());

            return json_decode((string) $response->getBody(), true)['data'][0]['attributes'];
        };

        $this->assertArrayNotHasKey('ticketCount', $as(null));
        $this->assertArrayNotHasKey('ticketCount', $as(2));
        $this->assertSame(1, $as(1)['ticketCount']);
    }
}
