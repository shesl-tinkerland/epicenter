# Identity and Partition Are Different Axes

The self-host naming question only gets clear once identity and partition are separated.

An authenticated principal is who the server thinks made the request. An owner partition is the storage namespace the request may touch. Those are the same value in Epicenter Cloud. They are intentionally different values on a self-hosted instance.

```txt
Identity answers: who made this request?
Partition answers: which storage namespace may it touch?
```

```txt
perUser
  authenticated principal = c.var.user.id
  owner partition = c.var.user.id
  route allowed = /api/owners/<user.id>/...
  cardinality = N partitions
  identity and partition are coupled

instance
  authenticated principal = whatever the bearer resolver returns
  owner partition = INSTANCE_OWNER_ID, always "instance"
  route allowed = /api/owners/instance/...
  cardinality = 1 partition
  identity and partition are decoupled
```

That word, coupled, is doing real work. In the `perUser` topology, the user's identity determines the storage namespace:

```txt
auth user: alice
  -> owner partition: owners/alice

auth user: bob
  -> owner partition: owners/bob
```

Adding another user adds another partition. That is exactly right for hosted Cloud: OAuth resolves a user, billing and isolation follow that user, and `requireOwnership` rejects any route trying to cross into another user's namespace.

The self-hosted instance needs a different invariant. Today every valid bearer resolves to the same named principal, but the future seam is per-token identity:

```txt
auth principal: alice-token
  -> owner partition: owners/instance

auth principal: bob-token
  -> owner partition: owners/instance
```

That is the reason the instance cannot be `perUser` with a fixed owner id. If the partition rule derives from identity, then the first day the bearer resolver returns `alice` and `bob`, the data silently splits into `owners/alice` and `owners/bob`. The whole point of the instance rule is that named tokens can later add attribution and revocation without repartitioning the box's data.

So the two rules are not "hosted" and "self-hosted" in disguise. They are partition rules:

```txt
perUser:  derive the partition from the authenticated user
instance: pin the partition to the instance, independent of user identity
```

```txt
Named tokens should change who the server sees, not where the instance stores data.
```

## Why not `shared`

`shared` sounds reasonable because a multi-person instance is shared by humans. It is still the wrong name for the rule.

Shared by whom? Admitted how? Revoked how? Attributed how? The word pulls membership and collaboration policy back into the server shape. ADR-0075 refuses those surfaces for v1. A solo homelab and a family wiki are the same topology: one partition, one bearer, one route namespace. "Shared" makes them sound like different modes again.

The server should not care how many people hold the token. It should care that every valid request lands in `owners/instance`.

```txt
"Shared" describes who holds the token.
"Instance" describes the partition rule.
```

## Why not `singlePartition`

`singlePartition` is the strongest alternate name. It is mechanically precise:

```txt
perUser
singlePartition
```

That pair is more symmetric than `perUser` / `instance`. It says exactly what varies: N partitions keyed by user versus one partition pinned to a constant.

The cost is that it names the storage mechanism instead of the deployable concept. The call site becomes:

```ts
const ownership = singlePartition;
```

That is accurate, but it is not how the rest of the repository talks about the product. ADR-0075 names the self-hosted artifact as an instance: one runnable star, one pinned partition, one operator-supplied bearer. The app folder is `apps/self-host`, but the thing it runs is the instance. The public health response says `product: 'instance'`. The docs tell the operator to configure an instance.

So `singlePartition` is the clean-room taxonomy name. `instance` is the repository name. It is precise enough because the nearby code and docs spell out the invariant: this instance owns exactly one partition, `owners/instance`, and identity never selects a different partition.

```txt
singlePartition is the clean-room taxonomy name.
instance is the repository name.
```

## The asymmetry is acceptable

`perUser` / `instance` is not perfectly symmetric. One name describes derivation; the other names the deployment topology.

That asymmetry is acceptable because the two sides are not equal product knobs. `perUser` is a reusable partition rule for hosted multi-tenancy. `instance` is the self-hosted composition ADR-0075 settles on. The pair reads well at the only call sites that matter:

```ts
// Epicenter Cloud
const ownership = perUser;

// Self-hosted instance
const ownership = instance;
```

The danger would be letting `instance` mean "whatever self-host happens to do today." The code prevents that by making the rule concrete:

```txt
instance = always resolve the owner partition to INSTANCE_OWNER_ID
```

That is the stable rule. If a future deployment needs on-prem multi-tenancy, it should not mutate `instance`. It should introduce a new topology with a new name and a new ADR, because it would have a different partition invariant.

```txt
Do not mutate instance into on-prem multi-tenancy.
Name a new topology when the partition invariant changes.
```

## The practical rule

Use the name that answers the next maintainer's question at the call site.

For Cloud, the maintainer needs to know that each authenticated user gets their own partition. `perUser` says that.

For self-host, the maintainer needs to know that this is the single-partition instance from ADR-0075. `instance` says that, and `ownership.ts` pins the storage fact in one switch arm.

The names are not trying to describe every possible deployment. They describe the two ownership shapes the server library currently composes:

```txt
perUser
  identity selects partition

instance
  deployment selects partition
```
