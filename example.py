lazy import json
groups = [[1, 2], [3, 4], [5]]
numbers = [*group for group in groups]
options = frozendict(indent=2)
print(json.dumps({"numbers": numbers}, indent=options["indent"]))
