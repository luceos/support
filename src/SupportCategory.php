<?php

namespace LinkRobins\Support;

use Flarum\Database\AbstractModel;
use Flarum\Group\Group;
use Flarum\User\User;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use LinkRobins\Support\Access\SupportAbilities;
use LinkRobins\Support\TicketType\StandardTicketType;
use LinkRobins\Support\TicketType\TicketTypeInterface;
use LinkRobins\Support\TicketType\TicketTypeManager;

/**
 * @property int $id
 * @property string $name
 * @property string $slug
 * @property string|null $description
 * @property string|null $color
 * @property string|null $icon
 * @property int $position
 * @property string|null $ticket_type
 * @property int|null $default_assignee_id
 * @property array<int>|null $allowed_group_ids
 * @property int $ticket_count
 * @property \Carbon\Carbon|null $created_at
 * @property \Carbon\Carbon|null $updated_at
 * @property-read User|null $defaultAssignee
 * @property-read \Illuminate\Database\Eloquent\Collection<int, SupportTicket> $tickets
 */
class SupportCategory extends AbstractModel
{
    protected $table = 'linkrobins_support_categories';

    public $timestamps = true;

    protected $fillable = [
        'name',
        'slug',
        'description',
        'color',
        'icon',
        'position',
        'ticket_type',
        'default_assignee_id',
        'allowed_group_ids',
    ];

    protected $casts = [
        'position'  => 'integer',
        'ticket_count' => 'integer',
        'allowed_group_ids' => 'array',
    ];

    /**
     * Resolve the ticket type driver for this category.
     * Defaults to Standard if not specified.
     */
    public function ticketType(): TicketTypeInterface
    {
        /** @var TicketTypeManager $manager */
        $manager = resolve(TicketTypeManager::class);

        // An unregistered id (say its extension was disabled) falls back to
        // standard inside the manager. A driver that fails to build is a bug
        // and must surface, not quietly turn appeals into standard tickets.
        return $manager->get($this->ticket_type ?: StandardTicketType::ID);
    }

    /**
     * Check if this category's ticket type driver represents an appeal.
     */
    public function isAppeal(): bool
    {
        return $this->ticketType()->isAppeal();
    }

    public function tickets(): HasMany
    {
        return $this->hasMany(SupportTicket::class, 'category_id');
    }

    /**
     * Recount the stored ticket_count of the given categories. A recount
     * rather than an increment, so a write that skipped the model hooks is
     * corrected by the next ticket change instead of drifting for good.
     * Soft-deleted tickets don't count, as with tickets().
     */
    public static function refreshTicketCount(int|string|null ...$ids): void
    {
        foreach (array_unique(array_filter(array_map('intval', $ids))) as $id) {
            static::query()->whereKey($id)->update([
                'ticket_count' => SupportTicket::query()->where('category_id', $id)->count(),
            ]);
        }
    }

    /**
     * The staff member new tickets in this category are handed to. Null means
     * no auto-assign: tickets arrive unassigned and every staff member is
     * notified about them.
     *
     * @return BelongsTo<User, $this>
     */
    public function defaultAssignee(): BelongsTo
    {
        return $this->belongsTo(User::class, 'default_assignee_id');
    }

    /**
     * The default assignee, but only if they can still act on tickets.
     *
     * The configured user can stop being staff long after the category was
     * set up -- moved out of a group, permission revoked, account deleted --
     * and auto-assigning to them then would park every new ticket on someone
     * who cannot open it, with only that person notified. Treat that exactly
     * like no auto-assign at all: the ticket stays unassigned and the whole
     * staff list hears about it. Failing open is the only safe direction
     * here, because the alternative is a ticket nobody is told about.
     */
    public function effectiveDefaultAssignee(): ?User
    {
        if (! $this->default_assignee_id) {
            return null;
        }

        $user = $this->defaultAssignee;

        return ($user instanceof User && SupportAbilities::isStaff($user)) ? $user : null;
    }

    /**
     * Determine if a user may create a ticket in this category.
     * Combines the ticket type driver's eligibility check with
     * any admin-configured allowed user groups.
     */
    public function canCreate(User $actor): bool
    {
        if ($actor->isGuest()) {
            return false;
        }

        if (! $this->ticketType()->canCreate($actor, $this)) {
            return false;
        }

        if (! empty($this->allowed_group_ids)) {
            if ($actor->isAdmin()) {
                return true;
            }

            $userGroupIds = array_map('intval', $actor->groups->pluck('id')->all());
            $userGroupIds[] = Group::MEMBER_ID;
            $allowedInts = array_map('intval', $this->allowed_group_ids);
            if (empty(array_intersect($userGroupIds, $allowedInts))) {
                return false;
            }
        }

        return true;
    }
}
