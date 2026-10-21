<?php

use Illuminate\Database\Schema\Builder;

// Count each existing category's tickets once. Soft-deleted tickets are left
// out, matching SupportCategory::refreshTicketCount(). Nothing to undo: rolling
// back the previous migration drops the column.
return [
    'up' => function (Builder $schema) {
        $db = $schema->getConnection();

        foreach ($db->table('linkrobins_support_categories')->pluck('id') as $id) {
            $db->table('linkrobins_support_categories')->where('id', $id)->update([
                'ticket_count' => $db->table('linkrobins_support_tickets')
                    ->where('category_id', $id)
                    ->whereNull('deleted_at')
                    ->count(),
            ]);
        }
    },

    'down' => function (Builder $schema) {
    },
];
