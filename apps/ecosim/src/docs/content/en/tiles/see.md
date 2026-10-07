```brain noframe when
{ "tile": "tile.sensor->sensor.see" }
```

# See

Fires when this creature can see another one. Sight is a cone pointing wherever the creature faces, reaching 600 pixels: carnivores and herbivores see 234 degrees wide, plants see all the way around. When several creatures pass the modifiers, the target is the nearest of them. Sight refreshes every third tick, so the answer can be up to two ticks old. In the game world crates block the view; boundary walls never do, and a rehearsal arena holds no crates at all.

---

Place `tile:tile.sensor->sensor.see` on the **WHEN** side of a rule to detect other actors in visible range.
Combine with modifier tiles like `tile:tile.modifier->modifier.actor_kind.carnivore` or
`tile:tile.modifier->modifier.actor_kind.plant` to filter what is detected.

## What a creature can see

Sight is a cone, not a circle. The cone points wherever the creature is facing, and it stops at
600 pixels -- a bit over half the width of the 1024-pixel-wide world.

| Creature  | How wide the cone is    | How far it reaches |
| --------- | ----------------------- | ------------------ |
| carnivore | 234 degrees             | 600 px             |
| herbivore | 234 degrees             | 600 px             |
| plant     | all around, 360 degrees | 600 px             |

So a creature can be standing very close and still be invisible, if it is behind you.

## Only one target, and it is the nearest

Several creatures can pass the modifiers at the same time. `tile:tile.sensor->sensor.see` picks the
**nearest** of them as the target, and that is the one
`tile:tile.modifier->modifier.movement.toward` steers at. The others are not thrown away:
`tile:tile.actuator->actuator.move` with `tile:tile.modifier->modifier.movement.awayfrom` backs off
from the middle of the two nearest instead of just the one.

## Crates block the view

In the game world, crates block line of sight. A creature standing behind a crate is not seen, even
when it is well inside the cone and well inside 600 pixels. The boundary walls around the edge of
the world never block sight.

A rehearsal arena holds no crates. If a rehearsal sees nothing, the reason is distance or facing --
never a crate.

## Sight refreshes every third tick

A creature re-checks what it can see on every third tick, and reuses the last answer in between.
A creature that dies in between drops out of that answer at once, so see never targets one that is
gone. Right at the edge of a distance filter, that can make a rule look like it fires only some of the
time. That is the refresh cadence showing through, not chance.

## Example

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.sensor->sensor.see",
        "tile.modifier->modifier.actor_kind.herbivore",
        "tile.modifier->modifier.distance.nearby"
      ],
      "do": [
        "tile.actuator->actuator.move",
        "tile.modifier->modifier.movement.toward"
      ],
      "children": [],
      "comment": "Move toward a nearby herbivore in vision range."
    }
  ],
  "catalog": []
}
```

## Modifiers

| Tile                                                | Description                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `tile:tile.modifier->modifier.actor_kind.carnivore` | Only see carnivores                                                                                      |
| `tile:tile.modifier->modifier.actor_kind.herbivore` | Only see herbivores                                                                                      |
| `tile:tile.modifier->modifier.actor_kind.plant`     | Only see plants                                                                                          |
| `tile:tile.modifier->modifier.distance.nearby`      | Keep only creatures within 100 px. Add up to three to tighten it: 100 px, then about 71, then about 58.   |
| `tile:tile.modifier->modifier.distance.faraway`     | Keep only creatures at least 300 px out. Add up to three to push it out: 300 px, then about 424, then about 520. |

You may stack nearby or far away, but not both on the same `tile:tile.sensor->sensor.see`.

## See Also

`tile:tile.modifier->modifier.distance.nearby`
`tile:tile.modifier->modifier.distance.faraway`
`tile:tile.sensor->sensor.bump`
`tile:tile.actuator->actuator.move`
`tile:tile.actuator->actuator.turn`
`tile:tile.actuator->actuator.shoot`
