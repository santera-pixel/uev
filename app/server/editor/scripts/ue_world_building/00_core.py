def _structure_result(structure_name, actors, metadata=None):
    actor_summaries = [get_actor_summary(actor) for actor in actors]
    return {
        "success": True,
        "structure": structure_name,
        "actor_count": len(actor_summaries),
        "actors": actor_summaries,
        "metadata": metadata or {},
    }


def _spawn_box(actors, label, location, scale, material_path=None):
    actor = spawn_basic_shape_actor(
        label,
        location,
        scale=scale,
        shape_name="cube",
        material_identifier=material_path,
    )
    actors.append(actor)
    return actor


def _build_wall(
    actors,
    prefix,
    center,
    segments,
    segment_length,
    height,
    thickness,
    axis="x",
    material_path=None,
):
    for index in range(int(segments)):
        location = [float(center[0]), float(center[1]), float(center[2])]
        offset = (index - (float(segments) - 1.0) / 2.0) * float(segment_length)
        if axis == "x":
            location[0] += offset
            scale = [float(segment_length) / 100.0, float(thickness) / 100.0, float(height) / 100.0]
        else:
            location[1] += offset
            scale = [float(thickness) / 100.0, float(segment_length) / 100.0, float(height) / 100.0]

        _spawn_box(
            actors,
            "{0}_Wall_{1}".format(prefix, index),
            location,
            scale,
            material_path=material_path,
        )


def _build_staircase_geometry(
    actors,
    prefix,
    origin,
    steps,
    step_width,
    step_height,
    step_depth,
    material_path=None,
):
    for step_index in range(int(steps)):
        location = [
            float(origin[0]) + step_index * float(step_depth),
            float(origin[1]),
            float(origin[2]) + step_index * float(step_height),
        ]
        scale = [
            float(step_depth) / 100.0,
            float(step_width) / 100.0,
            float(step_height) / 100.0,
        ]
        _spawn_box(
            actors,
            "{0}_Step_{1}".format(prefix, step_index),
            location,
            scale,
            material_path=material_path,
        )


def _build_arch_geometry(
    actors,
    prefix,
    origin,
    span_width,
    pillar_height,
    pillar_width,
    beam_height,
    material_path=None,
):
    half_span = float(span_width) / 2.0
    base_z = float(origin[2])
    pillar_scale = [
        float(pillar_width) / 100.0,
        float(pillar_width) / 100.0,
        float(pillar_height) / 100.0,
    ]

    _spawn_box(
        actors,
        "{0}_Pillar_L".format(prefix),
        [float(origin[0]) - half_span, float(origin[1]), base_z],
        pillar_scale,
        material_path=material_path,
    )
    _spawn_box(
        actors,
        "{0}_Pillar_R".format(prefix),
        [float(origin[0]) + half_span, float(origin[1]), base_z],
        pillar_scale,
        material_path=material_path,
    )
    _spawn_box(
        actors,
        "{0}_Beam".format(prefix),
        [
            float(origin[0]),
            float(origin[1]),
            base_z + float(pillar_height),
        ],
        [
            (float(span_width) + float(pillar_width)) / 100.0,
            float(pillar_width) / 100.0,
            float(beam_height) / 100.0,
        ],
        material_path=material_path,
    )


def _build_tower_geometry(
    actors,
    prefix,
    origin,
    width,
    floors,
    floor_height,
    material_path=None,
):
    total_height = float(floors) * float(floor_height)
    _spawn_box(
        actors,
        "{0}_Core".format(prefix),
        [float(origin[0]), float(origin[1]), float(origin[2]) + total_height / 2.0],
        [float(width) / 100.0, float(width) / 100.0, total_height / 100.0],
        material_path=material_path,
    )

    battlement_size = max(float(width) * 0.2, 50.0)
    top_z = float(origin[2]) + total_height + battlement_size / 2.0
    offsets = [
        (-float(width) / 2.5, -float(width) / 2.5),
        (-float(width) / 2.5, float(width) / 2.5),
        (float(width) / 2.5, -float(width) / 2.5),
        (float(width) / 2.5, float(width) / 2.5),
    ]
    for index, (offset_x, offset_y) in enumerate(offsets):
        _spawn_box(
            actors,
            "{0}_Battlement_{1}".format(prefix, index),
            [float(origin[0]) + offset_x, float(origin[1]) + offset_y, top_z],
            [
                battlement_size / 100.0,
                battlement_size / 100.0,
                battlement_size / 100.0,
            ],
            material_path=material_path,
        )


def _build_house_geometry(
    actors,
    prefix,
    origin,
    width,
    depth,
    wall_height,
    wall_thickness,
    roof_height,
    material_path=None,
):
    width = float(width)
    depth = float(depth)
    wall_height = float(wall_height)
    wall_thickness = float(wall_thickness)
    roof_height = float(roof_height)
    origin = [float(origin[0]), float(origin[1]), float(origin[2])]

    _spawn_box(
        actors,
        "{0}_Floor".format(prefix),
        [origin[0], origin[1], origin[2]],
        [width / 100.0, depth / 100.0, wall_thickness / 120.0],
        material_path=material_path,
    )

    wall_z = origin[2] + wall_height / 2.0
    _spawn_box(
        actors,
        "{0}_Wall_N".format(prefix),
        [origin[0], origin[1] + depth / 2.0, wall_z],
        [width / 100.0, wall_thickness / 100.0, wall_height / 100.0],
        material_path=material_path,
    )
    _spawn_box(
        actors,
        "{0}_Wall_S".format(prefix),
        [origin[0], origin[1] - depth / 2.0, wall_z],
        [width / 100.0, wall_thickness / 100.0, wall_height / 100.0],
        material_path=material_path,
    )
    _spawn_box(
        actors,
        "{0}_Wall_E".format(prefix),
        [origin[0] + width / 2.0, origin[1], wall_z],
        [wall_thickness / 100.0, depth / 100.0, wall_height / 100.0],
        material_path=material_path,
    )
    _spawn_box(
        actors,
        "{0}_Wall_W".format(prefix),
        [origin[0] - width / 2.0, origin[1], wall_z],
        [wall_thickness / 100.0, depth / 100.0, wall_height / 100.0],
        material_path=material_path,
    )
    _spawn_box(
        actors,
        "{0}_Roof".format(prefix),
        [origin[0], origin[1], origin[2] + wall_height + roof_height / 2.0],
        [(width * 1.05) / 100.0, (depth * 1.05) / 100.0, roof_height / 100.0],
        material_path=material_path,
    )
