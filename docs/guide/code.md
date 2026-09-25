# Code in flows

Any flow can run your own code with no AI: scripts in **Python**, **Node** or
**shell**, written on the flow's **Scripts** panel or already in the project
(`scripts/enrich.py`). Scripts belong to the project, so one script can serve
every flow in it, and each save is a new version.

## As a step

Add a **Run a script** zone and choose the script.

- **It gets the card** as JSON on stdin, and in the file named by
  `$FLOW_INPUT`: the title, details, email, note, owner, where the card came
  from, and what every earlier zone produced. `$FLOW_CARD_TITLE`,
  `$FLOW_NAME` and `$FLOW_PROJECT` (the project's folder) are set too.
- **What it prints is the step's result.** Later zones use it as
  `{{stage.<zone id>}}`, in a draft, an email, a web request or a message.
- **It can pick where the card goes.** Give the zone some answers, each
  leading to a zone. If the script's last line is `goto: Urgent`, the card
  goes where "Urgent" leads. Without one, it goes to the zone's next step.
- **Exit 0 passes.** Anything else takes the zone's failure path, with the
  end of its output.
- **Where it runs:** an empty folder (fast, for scripts that work on data),
  or a copy of the project at the card's work, after the project's setup
  (for tests and checks on code).
- **Secrets:** save them on the zone's Secrets and tick the ones the script
  gets; it reads each as a variable of the same name. Their values never
  reach a card, a log or a page. A card waits, saying which, until they're
  saved.

```python
import json, sys
card = json.load(sys.stdin)["card"]
size = 500 if "Acme" in card["title"] else 5
print(f"About {size} people")
print("goto: Big" if size > 100 else "goto: Small")
```

## As a trigger

A **Schedule** trigger can run a script instead of making one card: each item
it prints becomes a card. Print one item per line, as a title or as JSON like
`{"title": "Order 42", "description": "Two mugs", "key": 42}`. The same item
(by its key, or its words) never makes two cards, so a script can simply list
everything that's open. **Run now** on the Triggers panel runs it straight
away. `$FLOW_LAST_RUN` says when it last ran.

## Safety

Card text reaches a script only as data, never as part of a command. Scripts
run inside the same fence as agents, so they can't read Standing Orders' own
database or keys. They run with a plain environment rather than yours, and
stop at their time limit (1 to 60 minutes). Python scripts need `python3`
installed; Node scripts use the Node that runs Standing Orders.
