```brain noframe do
{ "tile": "${tileId}" }
```

# Gets

Sets a variable, or a part of something, to a new value.

---

Place the variable on the left, the `tile:tile.op->assign` tile in the middle, and the value you want to store on the right. You can read this as "variable **gets** value."

## Examples

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.sensor->on-page-entered"
      ],
      "do": [
        "tile.var->xScore0000000001",
        "tile.op->assign",
        "tile.literal->number:<number>->0"
      ],
      "children": [],
      "comment": "When the page starts, set `score` to `0`."
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->xScore0000000001",
      "varName": "score",
      "varType": "number:<number>",
      "uniqueId": "xScore0000000001"
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

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.sensor->sensor.timeout"
      ],
      "do": [
        "tile.var->ibWFtpaeKzpyyB6b",
        "tile.op->assign",
        "tile.var->ibWFtpaeKzpyyB6b",
        "tile.op->sub",
        "tile.literal->number:<number>->1"
      ],
      "children": [],
      "comment": "Once per second, subtract `1` from `countdown`."
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->ibWFtpaeKzpyyB6b",
      "varName": "countdown",
      "varType": "number:<number>",
      "uniqueId": "ibWFtpaeKzpyyB6b"
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

Works with any variable type -- numbers, booleans, strings, and the data types an application defines.

## See Also

`tile:tile.op->eq`
`tile:tile.op->ne`
