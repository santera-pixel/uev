import random


def create_pyramid(args):
    prefix = args.get("prefix") or "Pyramid"
    origin = args.get("location") or [0.0, 0.0, 0.0]
    levels = int(args.get("levels", 6))
    block_size = float(args.get("block_size", 200.0))
    actors = []

    for level in range(levels):
        size = levels - level
        for row in range(size):
            for col in range(size):
                _spawn_box(
                    actors,
                    "{0}_L{1}_{2}_{3}".format(prefix, level, row, col),
                    [
                        float(origin[0]) + row * block_size,
                        float(origin[1]) + col * block_size,
                        float(origin[2]) + level * block_size * 0.5,
                    ],
                    [
                        block_size / 100.0,
                        block_size / 100.0,
                        (block_size * 0.5) / 100.0,
                    ],
                    material_path=args.get("material_path"),
                )
    return _structure_result("create_pyramid", actors, {"levels": levels})


def create_maze(args):
    prefix = args.get("prefix") or "Maze"
    origin = args.get("location") or [0.0, 0.0, 0.0]
    rows = int(args.get("rows", 5))
    cols = int(args.get("cols", 5))
    cell_size = float(args.get("cell_size", 300.0))
    wall_height = float(args.get("wall_height", 220.0))
    wall_thickness = float(args.get("wall_thickness", 35.0))
    random_gen = random.Random(int(args.get("seed", 1337)))
    actors = []

    cells = {
        (row, col): {"N": True, "S": True, "E": True, "W": True}
        for row in range(rows)
        for col in range(cols)
    }
    visited = set()
    stack = [(0, 0)]
    direction_data = {
        "N": (-1, 0, "S"),
        "S": (1, 0, "N"),
        "E": (0, 1, "W"),
        "W": (0, -1, "E"),
    }

    while stack:
        current = stack[-1]
        visited.add(current)
        row, col = current
        neighbors = []
        for direction, (row_delta, col_delta, opposite) in direction_data.items():
            neighbor = (row + row_delta, col + col_delta)
            if (
                0 <= neighbor[0] < rows
                and 0 <= neighbor[1] < cols
                and neighbor not in visited
            ):
                neighbors.append((direction, neighbor, opposite))

        if not neighbors:
            stack.pop()
            continue

        direction, neighbor, opposite = random_gen.choice(neighbors)
        cells[current][direction] = False
        cells[neighbor][opposite] = False
        stack.append(neighbor)

    def _spawn_wall_segment(label, center, horizontal):
        _spawn_box(
            actors,
            label,
            center,
            [
                (cell_size if horizontal else wall_thickness) / 100.0,
                (wall_thickness if horizontal else cell_size) / 100.0,
                wall_height / 100.0,
            ],
            material_path=args.get("material_path"),
        )

    for row in range(rows):
        for col in range(cols):
            cell_origin_x = float(origin[0]) + row * cell_size
            cell_origin_y = float(origin[1]) + col * cell_size
            cell_center = [cell_origin_x, cell_origin_y, float(origin[2]) + wall_height / 2.0]

            if row == 0 and cells[(row, col)]["N"]:
                _spawn_wall_segment(
                    "{0}_N_{1}_{2}".format(prefix, row, col),
                    [cell_center[0] - cell_size / 2.0, cell_center[1], cell_center[2]],
                    False,
                )
            if col == 0 and cells[(row, col)]["W"]:
                _spawn_wall_segment(
                    "{0}_W_{1}_{2}".format(prefix, row, col),
                    [cell_center[0], cell_center[1] - cell_size / 2.0, cell_center[2]],
                    True,
                )
            if cells[(row, col)]["S"]:
                _spawn_wall_segment(
                    "{0}_S_{1}_{2}".format(prefix, row, col),
                    [cell_center[0] + cell_size / 2.0, cell_center[1], cell_center[2]],
                    False,
                )
            if cells[(row, col)]["E"]:
                _spawn_wall_segment(
                    "{0}_E_{1}_{2}".format(prefix, row, col),
                    [cell_center[0], cell_center[1] + cell_size / 2.0, cell_center[2]],
                    True,
                )

    return _structure_result("create_maze", actors, {"rows": rows, "cols": cols})
