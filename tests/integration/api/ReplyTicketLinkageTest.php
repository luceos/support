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
 * A reply always carries linkage to its ticket, even without
 * `include=ticket`. Realtime pushes a reply through its show endpoint with no
 * includes, and open ticket pages rely on this linkage to skip replies that
 * belong to other tickets instead of refetching.
 */
class ReplyTicketLinkageTest extends TestCase
{
    use RetrievesAuthorizedUsers;

    public function setUp(): void
    {
        parent::setUp();

        $this->extension('linkrobins-support');

        $now = Carbon::now()->subMinute();

        $this->prepareDatabase([
            'users' => [
                $this->normalUser(),
            ],
            'linkrobins_support_categories' => [
                ['id' => 1, 'name' => 'General', 'slug' => 'general', 'ticket_type' => 'standard', 'position' => 0, 'created_at' => $now, 'updated_at' => $now],
            ],
            'linkrobins_support_tickets' => [
                ['id' => 7, 'category_id' => 1, 'user_id' => 2, 'subject' => 'Help', 'status' => 'open', 'last_reply_at' => $now, 'created_at' => $now, 'updated_at' => $now],
            ],
            'linkrobins_support_replies' => [
                ['id' => 1, 'ticket_id' => 7, 'user_id' => 2, 'content' => '<t>Help</t>', 'is_internal_note' => 0, 'created_at' => $now, 'updated_at' => $now],
            ],
        ]);
    }

    #[Test]
    public function reply_without_includes_carries_ticket_linkage(): void
    {
        $response = $this->send($this->request('GET', '/api/linkrobins-support-replies/1', ['authenticatedAs' => 2]));
        $this->assertEquals(200, $response->getStatusCode(), (string) $response->getBody());

        $body = json_decode((string) $response->getBody(), true);
        $this->assertSame(
            ['type' => 'linkrobins-support-tickets', 'id' => '7'],
            $body['data']['relationships']['ticket']['data'] ?? null
        );
    }
}
