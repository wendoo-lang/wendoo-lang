# Literals

A literal is a fixed value typed directly into a rule. Use literals when you know the exact number,
true/false value, or text you want to compare against or assign.

## Number Literals

Type any number into the tile picker to create a number literal: `0`, `42`, `3.14`, `-1`.

Numbers can be displayed in different formats. Right-click a number literal tile and choose
**Edit Format** to switch between:

- **Default** -- plain decimal (e.g. `42`)
- **Percent** -- appends a `%` symbol (e.g. `42%`)
- **Fixed** -- fixed number of decimal places (e.g. `42.00`)
- **Thousands** -- comma-separated (e.g. `1,000`)
- **Time (seconds)** -- displays as `#s` (e.g. `5` shows as `5s`)
- **Time (milliseconds)** -- displays as `#ms` (e.g. `5` shows as `5000ms`)

## Boolean Literals

Boolean literals represent `true` or `false`. Use them in logic conditions
and with `tile:tile.op->assign` to set boolean variables.

## String Literals

String literals are short text values.

## Nil Literal

The nil literal stands for no value at all; `concept:nothing` has the details.

## When to Use a Literal vs. a Variable

Use a literal when the value never changes. Use a `tile:tile.op->assign` variable
when the value needs to change at runtime.

## Tips

- Literals are immutable -- the tile always represents the same value.
- Editing the format changes how the value is displayed, not the value itself.
- Literals are often paired with comparison operators: `tile:tile.op->gt`,
  `tile:tile.op->lt`, `tile:tile.op->eq`.
