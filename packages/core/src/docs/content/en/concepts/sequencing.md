# Putting Steps in Order

Two rules, one after the other, is most of what a brain does. A rule side holds one
action, so any plan with two steps in it takes two rules, and something has to say
which one goes second. There are two ways to say it: indent the second rule under the
first, or leave it where it is and give it THEN.

Both of them wait, and neither one is quicker than the other. The difference is whose
finish they wait for, and how much of that finish counts. An indented rule waits for
its parent's own action to be done. A THEN rule waits for everything the rule above it
started to be done -- that rule's action, every rule indented under it, and anything
those set going in turn.

## Three Shapes a Sequence Comes In

### A Staircase of Indents

A staircase puts steps in order without any THEN. Indent the second step under the
first, the third under the second, and keep going down. Each step takes its turn once
the step above it has finished its action.

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.sensor->on-page-entered"
      ],
      "do": [
        "tile.var->sTp4kR9vQm26Wz80",
        "tile.op->assign",
        "tile.literal->number:<number>->1"
      ],
      "children": [
        {
          "version": 1,
          "when": [],
          "do": [
            "tile.var->sTp4kR9vQm26Wz80",
            "tile.op->assign",
            "tile.literal->number:<number>->2"
          ],
          "children": [
            {
              "version": 1,
              "when": [],
              "do": [
                "tile.var->sTp4kR9vQm26Wz80",
                "tile.op->assign",
                "tile.literal->number:<number>->3"
              ],
              "children": [],
              "comment": "The third step, waiting on the second."
            }
          ],
          "comment": "The second step, waiting on the first."
        }
      ],
      "comment": "The page opens and the first step runs."
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->sTp4kR9vQm26Wz80",
      "varName": "step",
      "varType": "number:<number>",
      "uniqueId": "sTp4kR9vQm26Wz80"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->1",
      "valueType": "number:<number>",
      "value": 1,
      "valueLabel": "1",
      "displayFormat": "default"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->2",
      "valueType": "number:<number>",
      "value": 2,
      "valueLabel": "2",
      "displayFormat": "default"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->3",
      "valueType": "number:<number>",
      "value": 3,
      "valueLabel": "3",
      "displayFormat": "default"
    }
  ]
}
```

Going down the staircase is going forward in time, which is easy to read once you have
seen it once. It also means a step that does not happen takes everything below it with
it: an indented rule only gets a turn when the rule it sits under fires, so put a
condition on the middle step and the bottom step is out of the running too.

### A Flat THEN Chain

The same three steps, written without indenting anything:

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.sensor->on-page-entered"
      ],
      "do": [
        "tile.var->sTp4kR9vQm26Wz80",
        "tile.op->assign",
        "tile.literal->number:<number>->1"
      ],
      "children": [],
      "comment": "The page opens and the first step runs."
    },
    {
      "version": 1,
      "trigger": "then",
      "when": [],
      "do": [
        "tile.var->sTp4kR9vQm26Wz80",
        "tile.op->assign",
        "tile.literal->number:<number>->2"
      ],
      "children": [],
      "comment": "The second step, waiting on the first."
    },
    {
      "version": 1,
      "trigger": "then",
      "when": [],
      "do": [
        "tile.var->sTp4kR9vQm26Wz80",
        "tile.op->assign",
        "tile.literal->number:<number>->3"
      ],
      "children": [],
      "comment": "The third step, waiting on the second."
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->sTp4kR9vQm26Wz80",
      "varName": "step",
      "varType": "number:<number>",
      "uniqueId": "sTp4kR9vQm26Wz80"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->1",
      "valueType": "number:<number>",
      "value": 1,
      "valueLabel": "1",
      "displayFormat": "default"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->2",
      "valueType": "number:<number>",
      "value": 2,
      "valueLabel": "2",
      "displayFormat": "default"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->3",
      "valueType": "number:<number>",
      "value": 3,
      "valueLabel": "3",
      "displayFormat": "default"
    }
  ]
}
```

The first rule starts things off and each THEN under it waits for the step above. The
page reads as a list, top to bottom, and it stays a list however many steps you add.

These two programs do the same thing. For a plain straight line -- one step, then one
step, then one step -- the staircase and the chain are the same, and which one you
write is a question of what reads better to you.

### A THEN Chain Tucked Inside a Rule

You can also mix them. One rule up top decides whether the sequence happens at all, and
the steps live inside it as a short chain:

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.var->sCr7bN3jHy51Xd94",
        "tile.op->gt",
        "tile.literal->number:<number>->3"
      ],
      "do": [
        "tile.var->sTp4kR9vQm26Wz80",
        "tile.op->assign",
        "tile.literal->number:<number>->1"
      ],
      "children": [
        {
          "version": 1,
          "when": [],
          "do": [
            "tile.var->sTp4kR9vQm26Wz80",
            "tile.op->assign",
            "tile.literal->number:<number>->2"
          ],
          "children": [],
          "comment": "The first rule at a level is always a WHEN."
        },
        {
          "version": 1,
          "trigger": "then",
          "when": [],
          "do": [
            "tile.var->sTp4kR9vQm26Wz80",
            "tile.op->assign",
            "tile.literal->number:<number>->3"
          ],
          "children": [],
          "comment": "The chain carries on from there."
        }
      ],
      "comment": "Nothing inside happens unless this holds."
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->sTp4kR9vQm26Wz80",
      "varName": "step",
      "varType": "number:<number>",
      "uniqueId": "sTp4kR9vQm26Wz80"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->sCr7bN3jHy51Xd94",
      "varName": "score",
      "varType": "number:<number>",
      "uniqueId": "sCr7bN3jHy51Xd94"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->1",
      "valueType": "number:<number>",
      "value": 1,
      "valueLabel": "1",
      "displayFormat": "default"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->2",
      "valueType": "number:<number>",
      "value": 2,
      "valueLabel": "2",
      "displayFormat": "default"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->3",
      "valueType": "number:<number>",
      "value": 3,
      "valueLabel": "3",
      "displayFormat": "default"
    }
  ]
}
```

The head rule owns the sequence. If its condition does not hold, none of the steps
inside run. If it does, they take their turns in order. Indenting starts a fresh level
and the first rule at any level is always a WHEN, so a chain inside a rule opens with
WHEN and carries on with THEN.

## Where the Two Really Differ

They come apart as soon as one step sets more than one thing going.

```brain
{
  "ruleJsons": [
    {
      "version": 1,
      "when": [
        "tile.sensor->on-page-entered"
      ],
      "do": [
        "tile.var->sTp4kR9vQm26Wz80",
        "tile.op->assign",
        "tile.literal->number:<number>->1"
      ],
      "children": [
        {
          "version": 1,
          "when": [],
          "do": [
            "tile.var->sCr7bN3jHy51Xd94",
            "tile.op->assign",
            "tile.literal->number:<number>->0"
          ],
          "children": [],
          "comment": "Part of the firing above."
        },
        {
          "version": 1,
          "when": [],
          "do": [
            "tile.var->lVs2mF8qTk63Pn17",
            "tile.op->assign",
            "tile.literal->number:<number>->3"
          ],
          "children": [],
          "comment": "Also part of it, and it does not wait for the rule above."
        }
      ]
    },
    {
      "version": 1,
      "trigger": "then",
      "when": [],
      "do": [
        "tile.var->sTp4kR9vQm26Wz80",
        "tile.op->assign",
        "tile.literal->number:<number>->2"
      ],
      "children": [],
      "comment": "Waits for the first rule and both of the rules under it."
    }
  ],
  "catalog": [
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->sTp4kR9vQm26Wz80",
      "varName": "step",
      "varType": "number:<number>",
      "uniqueId": "sTp4kR9vQm26Wz80"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->sCr7bN3jHy51Xd94",
      "varName": "score",
      "varType": "number:<number>",
      "uniqueId": "sCr7bN3jHy51Xd94"
    },
    {
      "version": 1,
      "kind": "variable",
      "tileId": "tile.var->lVs2mF8qTk63Pn17",
      "varName": "lives",
      "varType": "number:<number>",
      "uniqueId": "lVs2mF8qTk63Pn17"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->0",
      "valueType": "number:<number>",
      "value": 0,
      "valueLabel": "0",
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
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->2",
      "valueType": "number:<number>",
      "value": 2,
      "valueLabel": "2",
      "displayFormat": "default"
    },
    {
      "version": 2,
      "kind": "literal",
      "tileId": "tile.literal->number:<number>->3",
      "valueType": "number:<number>",
      "value": 3,
      "valueLabel": "3",
      "displayFormat": "default"
    }
  ]
}
```

Rules 2 and 3 both belong to rule 1's firing. They do not wait for each other -- rule 2
takes its turn, then rule 3 takes its turn, and if rule 2 starts something slow, rule 3
does not stand around for it. Rule 4 is the one that waits for the lot: it has THEN, so
it holds back until rule 1's action and both of the rules under it are done.

That is the whole difference in one picture. An indented rule waits for its parent's
own action. A THEN waits for everything its neighbour above set going. In a straight
line those come to the same thing; the moment a step branches into several, they do
not. Either way, if a step fails outright, whatever was still to come is dropped rather
than run on half-finished work.

## What Indenting Is Good For

**The rules travel together.** A parent and everything under it are one block on the
page. Move the parent and the steps go with it, which is what you want when the steps
only make sense as part of that one thing happening.

**An indented rule can use what its parent found.** When the rule above spots something
-- an object, a reading, a number -- the rules underneath can work with the thing it
found. A THEN rule cannot: all it learns is that the step above finished, not what came
out of it.

**Several conditions under one firing.** Indent a few rules under a parent and give each
its own condition. They all get their turn from the one firing, and some fire while
others do not. Nested levels of that read naturally as "if this, and inside it, if that".

**The parent will not start over until the inside is done.** A rule cannot fire again
while anything it started is still going, so a staircase gives you that for free.

**It picks up the instant the action ends.** When the action above takes a while, an
indented rule takes its turn the moment that action finishes; a THEN takes its turn on
the next frame. On almost everything you will never notice.

## What THEN Is Good For

**The page stays flat.** Six indented steps march off the right-hand edge. Six THEN
steps are still a list you can read at a glance, and there is a limit to how many rules
you can nest anyway.

**One condition can shut off the rest of the line.** Put a condition on a THEN and a
miss stops not only that step but every step below it, without indenting anything. That
is worth knowing in both directions: it is a handy switch, and it is a common surprise.

**ELSE fits in beside it.** An ELSE rule under a THEN takes the frames the THEN did not
fire on, which includes every frame it is still waiting. That is the "meanwhile" branch,
or the "it did not happen" branch, and it sits right next to the step it belongs to.
`concept:trigger-modes` has the details.

**Each step checks its own condition at its own moment.** A link with a condition reads
it fresh, at the moment the step above finishes -- not back when the sequence started.

## Which One to Use

Ask where the sequence belongs.

If the steps are part of one thing happening -- one firing, going about its business
from start to finish -- indent them. The block moves as a unit, it counts as a single
piece of work to anything waiting on it, and nothing can restart it halfway through.

If the steps are a follow-on -- that finished, now do this -- give them THEN. The rule
above is free to go again, the page stays readable however long the line gets, and you
can hang an ELSE beside any step in it.

Past that, a fair amount of it is taste. Both forms handle an ordinary straight line of
steps perfectly well, so pick whichever one reads more clearly to the next person who
opens the page -- which is usually you, a week later.
