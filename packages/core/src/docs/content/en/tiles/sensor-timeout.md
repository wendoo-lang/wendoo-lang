```brain noframe when
{
  "tileId": "tile.sensor->sensor.timeout",
  "catalog": []
}
```

# Timer

Fires at the specified time interval.

---

Place `tile:tile.sensor->sensor.timeout` on the **WHEN** side of the rule to create time-based behavior.
Set the time interval by providing an anonymous numeric parameter. Value is in seconds.

## Example

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.sensor->sensor.timeout",
        "tile.literal->number:<number>->5[time_seconds]"
      ],
      "do": [
        "tile.actuator->switch-page",
        "tile.page->VaDrD7HLljXhpwy7"
      ],
      "children": [],
      "comment": "After five seconds, switch to the \"Regenerate\" page."
    }
  ],
  "catalog": [
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->5[time_seconds]",
      "valueType": "number:<number>",
      "value": 5,
      "valueLabel": "5",
      "displayFormat": "time_seconds"
    },
    {
      "version": 2,
      "kind": "page",
      "tileId": "tile.page->VaDrD7HLljXhpwy7",
      "pageId": "VaDrD7HLljXhpwy7",
      "label": "Regenerate"
    }
  ]
}
```

## Modifiers & Parameters

| Parameter   | Type     | Description                    |
| ----------- | -------- | ------------------------------ |
| (anonymous) | `Number` | The time interval, in seconds. |

## See Also

`tile:tile.sensor->on-page-entered`
`tile:tile.actuator->switch-page`
