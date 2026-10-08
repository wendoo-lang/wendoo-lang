# When There Is No Value

Sometimes there is no value to be had. Divide a number by zero, or read a variable that
has not been given anything yet, and what comes back is **nothing**. The
`tile:tile.literal->nil:<nil>->nil` tile stands for it.

Nothing is not `0`, `false`, or the empty text `""`. Those are values, and a brain uses
them like any other. Nothing is no value at all.

## Where Nothing Comes From

- **Dividing by zero.** `tile:tile.op->div` gives nothing when the number on its right
  is `0`.
- **Math with nothing in it.** Adding, subtracting, multiplying or dividing with nothing
  gives nothing, and so does joining a text to nothing.
- **A variable that has not been given anything yet**, when its data type has no empty
  value to start at. A number, true/false or text variable always starts at its empty
  value instead; `concept:variables` has the details.
- **Reading a part of nothing.** Some values have parts you can read. A part of nothing
  is nothing.

## Nothing Never Breaks a Brain

Reading a part of nothing gives nothing, and writing to a part of nothing changes
nothing. Neither one stops the brain: the rule carries on, holding nothing.

A WHEN side that comes out as nothing does not fire.

## Nothing in a Tile's Slot

Many tiles take a value placed right after them, which you can give or leave out.
`tile:tile.sensor->sensor.timeout` takes how long to wait, and
`tile:tile.actuator->switch-page` takes the page to go to.

Whether the slot is filled, and whether what is in it is something, are two separate
questions with two separate answers:

- If the value is missing, the tile runs. It makes its own choice for the empty slot --
  the timer, left empty, waits its usual time.
- If the value is present but it is nothing, the tile does not run. A DO tile does not
  act, and a WHEN tile does not fire.

If a tile has more than one value placed after it, any one of them being nothing is
enough to keep it from running. Placing the nil tile itself in the slot counts the same
as leaving the slot empty. This check is for a value placed right after the tile; a value
given after one of the tile's parameter tiles is not checked this way.

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.sensor->sensor.timeout",
        "tile.literal->number:<number>->10",
        "tile.op->div",
        "tile.var->spD4kQ7mWx29Tn58"
      ],
      "do": [
        "tile.var->ctR6hV3pLy84Jm17",
        "tile.op->assign",
        "tile.var->ctR6hV3pLy84Jm17",
        "tile.op->add",
        "tile.literal->number:<number>->1"
      ],
      "children": [],
      "comment": "Waits 10 divided by `speed` seconds, then adds `1` to `count`."
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->spD4kQ7mWx29Tn58",
      "varName": "speed",
      "varType": "number:<number>",
      "uniqueId": "spD4kQ7mWx29Tn58"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->ctR6hV3pLy84Jm17",
      "varName": "count",
      "varType": "number:<number>",
      "uniqueId": "ctR6hV3pLy84Jm17"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->10",
      "valueType": "number:<number>",
      "value": 10,
      "valueLabel": "10",
      "displayFormat": "default"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->1",
      "valueType": "number:<number>",
      "value": 1,
      "valueLabel": "1",
      "displayFormat": "default"
    }
  ]
}
```

While `speed` is `0`, ten divided by `speed` is nothing, so the timer does not run and
`count` stays where it is. As soon as `speed` is any other number, the timer goes back
to work.

## 0, false and Empty Text Are Values

`0`, `false` and `""` are never nothing, so they never keep a tile from running. A tile
given `0` runs, with `0`. Only nothing stops it.

## Checking for Nothing

Comparing nothing with a number or a text comes out false, whichever comparison you
use -- `tile:tile.op->ne` included. To ask whether a number, a true/false value or a
text is nothing, compare it with nil:

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [],
      "do": [
        "tile.var->rtB8nK2vQs57Hc40",
        "tile.op->assign",
        "tile.var->htM3wJ9xLp62Df85",
        "tile.op->div",
        "tile.var->trG7cZ4yNb18Kw93"
      ],
      "children": [],
      "comment": "While `tries` is `0`, `ratio` gets nothing."
    },
    {
      "version": 1,
      "when": [
        "tile.var->rtB8nK2vQs57Hc40",
        "tile.op->eq",
        "tile.literal->nil:<nil>->nil"
      ],
      "do": [
        "tile.var->rtB8nK2vQs57Hc40",
        "tile.op->assign",
        "tile.literal->number:<number>->0"
      ],
      "children": [],
      "comment": "Catches that, and makes `ratio` 0 instead."
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->rtB8nK2vQs57Hc40",
      "varName": "ratio",
      "varType": "number:<number>",
      "uniqueId": "rtB8nK2vQs57Hc40"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->htM3wJ9xLp62Df85",
      "varName": "hits",
      "varType": "number:<number>",
      "uniqueId": "htM3wJ9xLp62Df85"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->trG7cZ4yNb18Kw93",
      "varName": "tries",
      "varType": "number:<number>",
      "uniqueId": "trG7cZ4yNb18Kw93"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->0",
      "valueType": "number:<number>",
      "value": 0,
      "valueLabel": "0",
      "displayFormat": "default"
    }
  ]
}
```
