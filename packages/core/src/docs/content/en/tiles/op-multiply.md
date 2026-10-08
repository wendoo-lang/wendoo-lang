```brain noframe do
{ "tile": "${tileId}" }
```

# Multiply

Multiplies two values together.

---

Use on the **DO** side to compute a product, or on the **WHEN** side inside a comparison.

## Examples

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [],
      "do": [
        "tile.var->HXS9uhIksRLn1oVJ",
        "tile.op->assign",
        "tile.var->8xv0yZonz4xjIPqd",
        "tile.op->mul",
        "tile.var->oQ7jcLxIYNZb7gds"
      ],
      "children": [],
      "comment": "a = b * c"
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->HXS9uhIksRLn1oVJ",
      "varName": "a",
      "varType": "number:<number>",
      "uniqueId": "HXS9uhIksRLn1oVJ"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->8xv0yZonz4xjIPqd",
      "varName": "b",
      "varType": "number:<number>",
      "uniqueId": "8xv0yZonz4xjIPqd"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->oQ7jcLxIYNZb7gds",
      "varName": "c",
      "varType": "number:<number>",
      "uniqueId": "oQ7jcLxIYNZb7gds"
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
        "tile.var->xbeDmRdQEEpRPi3R",
        "tile.op->gt",
        "tile.var->JiGocXttZY4hfwNQ",
        "tile.op->mul",
        "tile.var->wmkXhqjQRJqAAxhx"
      ],
      "do": [],
      "children": [],
      "comment": "a > b * c"
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->xbeDmRdQEEpRPi3R",
      "varName": "a",
      "varType": "number:<number>",
      "uniqueId": "xbeDmRdQEEpRPi3R"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->JiGocXttZY4hfwNQ",
      "varName": "b",
      "varType": "number:<number>",
      "uniqueId": "JiGocXttZY4hfwNQ"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->wmkXhqjQRJqAAxhx",
      "varName": "c",
      "varType": "number:<number>",
      "uniqueId": "wmkXhqjQRJqAAxhx"
    }
  ]
}
```

## See Also

`tile:tile.op->div`
`tile:tile.op->add`
`tile:tile.op->sub`
`tile:tile.op->neg`
`tile:tile.op->assign`
`tile:tile.op->gt`
