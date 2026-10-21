<?php

use Flarum\Database\Migration;

// Stored so listing categories (or tickets with their category) never counts
// tickets on read. Kept current by SupportCategory::refreshTicketCount() from
// the ticket model hooks; filled for existing categories by the next migration.
return Migration::addColumns('linkrobins_support_categories', [
    'ticket_count' => ['integer', 'unsigned' => true, 'default' => 0],
]);
