# Variables

Variables let a brain store a value and read it back in a later rule or a later frame.

## Creating a Variable

To create a variable: select a "Create a Variable" tile from the tile picker for the data type you want, give it a name, and your new variable will be added to the brain you're editing.

## Starting Value

A brand-new number, true/false or text variable already holds the empty value for its data type:
a number starts at `0`, a true/false starts at `false`, and a text starts at `""` (the empty text).
A variable of a data type with no empty value starts out holding nothing until a rule assigns to
it; `concept:nothing` has the details.
You can read a variable straight away, before any rule has assigned to it -- a rule like
"WHEN the count is under three" works from the very first frame.

## Reading a Variable

Once a variable tile is created, it appears as a named tile in the tile picker.
Place the variable tile on the WHEN or DO side of any rule to read and make use of its current value.

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.var->nKFAPcyu3FGt4WXl",
        "tile.op->eq",
        "tile.literal->number:<number>->42"
      ],
      "do": [],
      "children": [],
      "comment": "\"foo == 42\" (checks if variable `foo`'s value is equal to `42`)"
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->nKFAPcyu3FGt4WXl",
      "varName": "foo",
      "varType": "number:<number>",
      "uniqueId": "nKFAPcyu3FGt4WXl"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->42",
      "valueType": "number:<number>",
      "value": 42,
      "valueLabel": "42",
      "displayFormat": "default"
    }
  ]
}
```

## Writing to a Variable

Use the `tile:tile.op->assign` operator to update a variable's value.
Put the variable tile on the left and a value expression on the right.

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [],
      "do": [
        "tile.var->0M0QfSMfXmKR1IFT",
        "tile.op->assign",
        "tile.literal->number:<number>->42"
      ],
      "children": [],
      "comment": "\"foo = 42\" (gives variable `foo` the value `42`)"
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->0M0QfSMfXmKR1IFT",
      "varName": "foo",
      "varType": "number:<number>",
      "uniqueId": "0M0QfSMfXmKR1IFT"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->42",
      "valueType": "number:<number>",
      "value": 42,
      "valueLabel": "42",
      "displayFormat": "default"
    }
  ]
}
```

## Variable Scope

Variables belong to a single brain and are not shared between brains.
Each brain instance has its own copy of every variable.

## Persistence

Variable values persist across frames. A value written in one frame is still there on the next frame,
unless the variable is reassigned. A variable holding something that has since been removed, such
as an object taken out of the world, reads as nothing.

## Tips

- Use variables to count events (e.g., how many times an event has happened).
- Use variables as flags -- assign `1` when something happens, check `> 0` in a later rule.
- Reset variables by assigning `0` or `false` in an `tile:tile.sensor->on-page-entered` rule.
