# Tool reference - UEV 1.7.0

Generated from the live /api/catalog of package 1.7.0, server 2026.11.6-1, protocol 2.

**45 tools** (7 direct + 38 namespaces), **393 actions**. Hidden compatibility aliases are not listed.

Every action uses the call shape POST /api/call {tool, action, params} or the equivalent MCP tool call. Parameters marked required must be present; alternatives appear as a | b.

## Direct tools

### `editor_capture_window`

Capture a desktop window, including Slate/UMG, to a PNG. Uses native Windows capture and best-effort macOS/Linux capture. Optional window_title selects a top-level window; falls back to the UE4Editor main window when that title is not open.

No named actions.

### `editor_create_object`

Create a new object/actor in the world

Example output: {'success': true, 'actor_name': 'StaticMeshActor_1', 'actor_label': 'MyCube', 'class': 'StaticMeshActor', 'location': {'x': 100.0, 'y': 200.0, 'z': 0.0}, 'rotation': {'pitch': 0.0, 'yaw': 45.0, 'roll': 0.0}, 'scale': {'x': 1.0, 'y': 1.0, 'z': 1.0}}

Returns created actor details with final transform values.

No named actions.

### `editor_delete_object`

Delete an object/actor from the world

Example output: {'success': true, 'message': 'Successfully deleted actor: MyCube', 'deleted_actor': {'actor_name': 'StaticMeshActor_1', 'actor_label': 'MyCube', 'class': 'StaticMeshActor', 'location': {'x': 100.0, 'y': 200.0, 'z': 0.0}}}

Returns deletion confirmation with details of the deleted actor.

No named actions.

### `editor_update_object`

Update an existing object/actor in the world

Example output: {'success': true, 'actor_name': 'StaticMeshActor_1', 'actor_label': 'UpdatedCube', 'class': 'StaticMeshActor', 'location': {'x': 150.0, 'y': 200.0, 'z': 50.0}, 'rotation': {'pitch': 0.0, 'yaw': 90.0, 'roll': 0.0}, 'scale': {'x': 2.0, 'y': 2.0, 'z': 2.0}}

Returns updated actor details with new transform values.

No named actions.

### `get_unreal_engine_path`

Get the active Unreal Engine root path from the connected editor session

No named actions.

### `get_unreal_project_path`

Get the active Unreal project file path from the connected editor session

No named actions.

### `manage_batch`

Run a sequential list of MCP tool calls in one request. Each call uses the normal namespace/direct safety guard. Recursion into manage_batch, manage_stack, and manage_debug.panic is rejected. Not atomic; end write batches with explicit save actions.

No named actions.

## Namespace tools

### `manage_actor`

Actor tool namespace for listing, searching, spawning, deleting, transforming, and inspecting level actors.

#### `manage_actor.delete`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |

#### `manage_actor.find`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `pattern` | string | no |  |
| `name` | string | no |  |

#### `manage_actor.get_material_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |

#### `manage_actor.get_properties`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |

#### `manage_actor.list`

No parameters.

#### `manage_actor.set_property`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `property_name` | string | yes |  |
| `property_value` | any | no |  |

#### `manage_actor.spawn`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `type` | string | no |  |
| `actor_type` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |

#### `manage_actor.spawn_blueprint`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_actor.transform`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |

### `manage_ai`

Inspect AI controllers, pawns, behavior trees, blackboards, navmesh actors, and perception; toggle debugger views; author behavior tree graphs (nodes, decorators, services, blackboard wiring, compile and repair); create behavior trees and blackboards; add, remove, and list blackboard keys; inspect and run behavior trees.

#### `manage_ai.actors`

No parameters.

#### `manage_ai.add_blackboard_key`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blackboard_path` | string | yes |  |
| `key_name` | string | yes |  |
| `key_type` | string | yes | values: Bool, Int, Float, Vector, Rotator, Name, String, Object, Class |
| `instance_synced` | boolean | no |  |
| `category` | string | no |  |
| `base_class` | string | no |  |

#### `manage_ai.assets`

No parameters.

#### `manage_ai.assign_behavior_tree`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `target` | string | yes |  |
| `pawn` | string | no |  |
| `spawn_if_missing` | boolean | no |  |
| `possess` | boolean | no |  |

#### `manage_ai.bt_add_decorator`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `node_id` | string | yes |  |
| `decorator_class` | string | yes |  |
| `properties` | object | no |  |
| `index` | number | no |  |
| `logic_op` | string | no | values: test |
| `save` | boolean | no |  |

#### `manage_ai.bt_add_node`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `parent_id` | string | no |  |
| `kind` | string | yes | values: composite, task |
| `node_class` | string | yes |  |
| `index` | number | no |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_add_service`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `node_id` | string | yes |  |
| `service_class` | string | yes |  |
| `properties` | object | no |  |
| `index` | number | no |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_compile`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_create`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `path` | string | no |  |
| `blackboard_path` | string | no |  |
| `root_class` | string | no |  |

#### `manage_ai.bt_inspect`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `include_graph` | boolean | no |  |

#### `manage_ai.bt_move_node`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `node_id` | string | yes |  |
| `new_parent_id` | string | yes |  |
| `new_index` | number | no |  |
| `index` | number | no |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_remove_decorator`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `node_id` | string | yes |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_remove_node`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `node_id` | string | yes |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_remove_service`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `node_id` | string | yes |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_repair_graph`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_set_blackboard`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `blackboard_path` | string | yes |  |
| `save` | boolean | no |  |

#### `manage_ai.bt_set_node_property`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |
| `node_id` | string | yes |  |
| `property` | string | yes |  |
| `value` | any | yes |  |
| `save` | boolean | no |  |

#### `manage_ai.create_behavior_tree`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `path` | string | no |  |

#### `manage_ai.create_blackboard`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `path` | string | no |  |

#### `manage_ai.inspect_behavior_tree`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `behavior_tree_path` | string | yes |  |

#### `manage_ai.list_blackboard_keys`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blackboard_path` | string | yes |  |

#### `manage_ai.navmesh`

No parameters.

#### `manage_ai.perception`

No parameters.

#### `manage_ai.remove_blackboard_key`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blackboard_path` | string | yes |  |
| `key_name` | string | yes |  |

#### `manage_ai.search_behavior_trees`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `asset_class` | string | no |  |
| `class_name` | string | no |  |
| `class` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

#### `manage_ai.status`

No parameters.

#### `manage_ai.toggle_debug`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `mode` | string | yes | values: navmesh, gameplay_debugger, perception |
| `confirm` | boolean | no |  |

### `manage_animation`

Animation authoring namespace for AnimBlueprint AnimGraphs and state machines, AnimSequence notifies/curves/markers, and AnimMontage slots/sections/segments/notifies.

#### `manage_animation.add_conduit`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `state_machine_node_id` | string | yes |  |
| `state_name` | string | no |  |
| `node_position` | array | no | array of number |

#### `manage_animation.add_curve_key`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `curve_name` | string | yes |  |
| `time` | number | yes |  |
| `value` | number | yes |  |

#### `manage_animation.add_graph_node`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_type` | string | no |  |
| `node_kind` | string | no |  |
| `node_class` | string | no |  |
| `graph_node_id` | string | no |  |
| `node_position` | array | no | array of number |
| `anim_asset` | string | no |  |
| `slot_name` | string | no |  |
| `function_name` | string | no |  |
| `target` | string | no |  |
| `variable_name` | string | no |  |
| `properties` | object | no |  |

#### `manage_animation.add_montage_notify`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `track_name` | string | no |  |
| `time` | number | yes |  |
| `duration` | number | no |  |
| `notify_class` | string | no |  |
| `notify_state_class` | string | no |  |
| `notify_name` | string | no |  |

#### `manage_animation.add_montage_section`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `section_name` | string | yes |  |
| `start_time` | number | yes |  |
| `next_section` | string | no |  |

#### `manage_animation.add_montage_segment`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `slot_name` | string | yes |  |
| `sequence_path` | string | yes |  |
| `start_pos` | number | no |  |
| `start_time` | number | no |  |
| `end_time` | number | no |  |
| `play_rate` | number | no |  |
| `loops` | number | no |  |

#### `manage_animation.add_montage_slot`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `slot_name` | string | yes |  |
| `sequence_path` | string | no |  |

#### `manage_animation.add_notify`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `track_name` | string | no |  |
| `time` | number | yes |  |
| `duration` | number | no |  |
| `notify_class` | string | no |  |
| `notify_state_class` | string | no |  |
| `notify_name` | string | no |  |

#### `manage_animation.add_notify_track`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `track_name` | string | yes |  |

#### `manage_animation.add_rule_node`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `transition_node_id` | string | yes |  |
| `node_type` | string | yes |  |
| `function_name` | string | no |  |
| `target` | string | no |  |
| `variable_name` | string | no |  |
| `object_path` | string | no |  |
| `node_class` | string | no |  |
| `node_position` | array | no | array of number |

#### `manage_animation.add_state`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `state_machine_node_id` | string | yes |  |
| `state_name` | string | no |  |
| `state_type` | string | no | values: single_animation, blend_graph |
| `connect_entry` | boolean | no |  |
| `node_position` | array | no | array of number |

#### `manage_animation.add_state_machine`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_position` | array | no | array of number |

#### `manage_animation.add_sync_marker`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `marker_name` | string | yes |  |
| `time` | number | yes |  |
| `track_name` | string | no |  |

#### `manage_animation.add_transition`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `from_state_node_id` | string | yes |  |
| `to_state_node_id` | string | yes |  |
| `priority` | number | no |  |
| `crossfade` | number | no |  |
| `bidirectional` | boolean | no |  |
| `automatic_rule` | boolean | no |  |
| `node_position` | array | no | array of number |

#### `manage_animation.compile`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_animation.connect_nodes`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `source_node_id` | string | yes |  |
| `source_pin` | string | yes |  |
| `target_node_id` | string | yes |  |
| `target_pin` | string | yes |  |

#### `manage_animation.create_anim_blueprint`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_name` | string | no |  |
| `name` | string | no |  |
| `path` | string | no |  |
| `skeleton` | string | yes |  |
| `preview_mesh` | string | no |  |

#### `manage_animation.create_montage`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_name` | string | no |  |
| `name` | string | no |  |
| `path` | string | no |  |
| `source_sequence` | string | yes |  |
| `slot_name` | string | no |  |

#### `manage_animation.delete_node`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |

#### `manage_animation.disconnect_nodes`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `source_node_id` | string | yes |  |
| `source_pin` | string | yes |  |
| `target_node_id` | string | no |  |
| `target_pin` | string | no |  |

#### `manage_animation.inspect_graph`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_node_id` | string | no |  |
| `graph_kind` | string | no |  |
| `include_nodes` | boolean | no |  |

#### `manage_animation.inspect_montage`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_animation.inspect_node_properties`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |

#### `manage_animation.inspect_sequence`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_animation.remove_curve`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `curve_name` | string | yes |  |

#### `manage_animation.remove_montage_notify`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `notify_name` | string | yes |  |

#### `manage_animation.remove_montage_section`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `section_name` | string | yes |  |

#### `manage_animation.remove_montage_segment`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `slot_name` | string | yes |  |
| `segment_index` | number | yes |  |

#### `manage_animation.remove_montage_slot`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `slot_name` | string | yes |  |

#### `manage_animation.remove_notify`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `notify_name` | string | yes |  |

#### `manage_animation.remove_notify_track`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `track_name` | string | yes |  |

#### `manage_animation.remove_state`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |

#### `manage_animation.remove_sync_marker`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `marker_name` | string | yes |  |

#### `manage_animation.remove_transition`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |

#### `manage_animation.rename_state`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |
| `state_name` | string | yes |  |

#### `manage_animation.save`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `sequence_path` | string | no |  |
| `montage_path` | string | no |  |

#### `manage_animation.search_animation_assets`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `limit` | number | no |  |

#### `manage_animation.set_montage_properties`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `blend_in` | number | no |  |
| `blend_out` | number | no |  |
| `blend_out_trigger` | number | no |  |
| `auto_blend_out` | boolean | no |  |
| `rate_scale` | number | no |  |
| `sync_group` | string | no |  |

#### `manage_animation.set_montage_section`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `montage_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `section_name` | string | no |  |
| `section_index` | number | no |  |
| `start_time` | number | no |  |
| `next_section` | string | no |  |

#### `manage_animation.set_node_property`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |
| `property` | string | yes |  |
| `value` | any | yes |  |

#### `manage_animation.set_sequence_properties`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `rate_scale` | number | no |  |
| `root_motion` | boolean | no |  |
| `properties` | object | no |  |

#### `manage_animation.set_state_properties`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |
| `always_reset_on_entry` | boolean | no |  |

#### `manage_animation.set_transition`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `anim_blueprint` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |
| `priority` | number | no |  |
| `crossfade` | number | no |  |
| `blend_mode` | string | no |  |
| `custom_blend_curve` | string | no |  |
| `blend_profile` | string | no |  |
| `bidirectional` | boolean | no |  |
| `automatic_rule` | boolean | no |  |

### `manage_asset`

Asset tool namespace for listing, searching, inspecting, exporting, validating, duplicating, renaming, moving, deleting, saving, and folder-management actions.

#### `manage_asset.create_folder`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `directory_path` | string | no |  |
| `folder_path` | string | no |  |
| `path` | string | no |  |

#### `manage_asset.delete`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `asset_paths` | array | no | array of string |

#### `manage_asset.delete_folder`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `directory_path` | string | no |  |
| `folder_path` | string | no |  |
| `path` | string | no |  |

#### `manage_asset.duplicate`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `source_asset_path` | string | no |  |
| `source_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `destination_asset_path` | string | no |  |
| `target_asset_path` | string | no |  |
| `destination_path` | string | no |  |
| `new_name` | string | no |  |
| `name` | string | no |  |

#### `manage_asset.exists`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `asset_paths` | array | no | array of string |

#### `manage_asset.export`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `destination_path` | string | no |  |
| `file_path` | string | no |  |
| `output_path` | string | no |  |
| `overwrite` | boolean | no |  |

#### `manage_asset.info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_asset.list`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `root_path` | string | no |  |
| `path` | string | no |  |
| `recursive` | boolean | no |  |
| `limit` | number | no |  |

#### `manage_asset.list_folder`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `directory_path` | string | no |  |
| `folder_path` | string | no |  |
| `path` | string | no |  |
| `recursive` | boolean | no |  |

#### `manage_asset.move`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `source_asset_path` | string | no |  |
| `source_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `destination_asset_path` | string | no |  |
| `target_asset_path` | string | no |  |
| `destination_path` | string | no |  |
| `new_name` | string | no |  |
| `name` | string | no |  |

#### `manage_asset.references`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_asset.rename`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `source_asset_path` | string | no |  |
| `source_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `destination_asset_path` | string | no |  |
| `target_asset_path` | string | no |  |
| `destination_path` | string | no |  |
| `new_name` | string | no |  |
| `name` | string | no |  |

#### `manage_asset.save`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `asset_paths` | array | no | array of string |
| `only_if_is_dirty` | boolean | no |  |

#### `manage_asset.search`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `asset_class` | string | no |  |
| `class_name` | string | no |  |
| `class` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

#### `manage_asset.validate`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_paths` | array | no | one of: string, array; array of string |
| `paths` | array | no | one of: string, array; array of string |

### `manage_audio`

Audio tool namespace for importing audio files, searching audio assets, and inspecting their asset metadata.

#### `manage_audio.audio_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_audio.import_audio`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `source_file` | string | no |  |
| `file_path` | string | no |  |
| `local_path` | string | no |  |
| `destination_path` | string | no |  |
| `content_path` | string | no |  |
| `path` | string | no |  |
| `asset_name` | string | no |  |
| `name` | string | no |  |
| `replace_existing` | boolean | no |  |
| `save` | boolean | no |  |
| `auto_create_cue` | boolean | no |  |
| `cue_suffix` | string | no |  |

#### `manage_audio.search_audio_assets`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `asset_class` | string | no |  |
| `class_name` | string | no |  |
| `class` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

### `manage_audit`

Read-only project audits for required plugins, remote-execution config, Vite cvars, and a consolidated summary.

#### `manage_audit.config_audit`

No parameters.

#### `manage_audit.cvar_audit`

No parameters.

#### `manage_audit.plugin_audit`

No parameters.

#### `manage_audit.project_summary`

No parameters.

### `manage_blueprint`

Blueprint tool namespace for Blueprint creation, component editing, graph/event/function/variable authoring, typed function signatures, local variables, macro libraries, Construction Script nodes, compilation, verification, and summary actions.

#### `manage_blueprint.add_component`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `component_type` | string | no |  |
| `class_name` | string | no |  |
| `component_name` | string | no |  |
| `name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `component_properties` | object | no |  |
| `parent_component_name` | string | no |  |

#### `manage_blueprint.add_local_variable`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `variable_name` | string | no |  |
| `pin_type` | string | no |  |
| `variable_type` | string | no |  |
| `default_value` | any | no |  |
| `category` | string | no |  |
| `flags` | object | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.add_node`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `node_type` | string | no |  |
| `node_class` | string | no |  |
| `event_name` | string | no |  |
| `target` | string | no |  |
| `component_name` | string | no |  |
| `variable_name` | string | no |  |
| `action_name` | string | no |  |
| `macro_library` | string | no |  |
| `macro_path` | string | no |  |
| `comment` | string | no |  |
| `node_position` | array | no | array of number |
| `params` | object | no |  |
| `properties` | object | no |  |

#### `manage_blueprint.add_variable`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `variable_name` | string | no |  |
| `variable_type` | string | yes |  |
| `default_value` | any | no |  |
| `is_exposed` | boolean | no |  |
| `is_instance_editable` | boolean | no |  |
| `category` | string | no |  |
| `tooltip` | string | no |  |

#### `manage_blueprint.compile`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_blueprint.connect_nodes`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_name` | string | no |  |
| `source_node_id` | string | yes |  |
| `source_pin` | string | yes |  |
| `target_node_id` | string | yes |  |
| `target_pin` | string | yes |  |

#### `manage_blueprint.create_blueprint`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `blueprint_name` | string | no |  |
| `parent_class` | string | no |  |
| `path` | string | no |  |

#### `manage_blueprint.create_function`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `function_name` | string | no |  |
| `inputs` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `outputs` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `flags` | array | no | one of: object, array; array of string |
| `category` | string | no |  |
| `tooltip` | string | no |  |
| `meta` | object | no |  |
| `duplicate_policy` | string | no | values: fail, reuse |
| `compile` | boolean | no |  |

#### `manage_blueprint.create_macro`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `macro_library` | string | no |  |
| `library_path` | string | no |  |
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `macro_name` | string | no |  |
| `name` | string | no |  |
| `inputs` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `outputs` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `description` | string | no |  |
| `category` | string | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.create_macro_library`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `macro_library_name` | string | no |  |
| `name` | string | no |  |
| `path` | string | no |  |
| `parent_class` | string | no |  |
| `save` | boolean | no |  |

#### `manage_blueprint.delete_function`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.delete_macro`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `macro_library` | string | no |  |
| `library_path` | string | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.delete_node`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_name` | string | no |  |
| `node_id` | string | yes |  |

#### `manage_blueprint.disconnect_nodes`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_name` | string | no |  |
| `source_node_id` | string | yes |  |
| `source_pin` | string | yes |  |
| `target_node_id` | string | no |  |
| `target_pin` | string | no |  |

#### `manage_blueprint.inspect_blueprint_model`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `include_graphs` | boolean | no |  |
| `include_functions` | boolean | no |  |
| `include_macros` | boolean | no |  |
| `include_components` | boolean | no |  |

#### `manage_blueprint.inspect_components`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_blueprint.inspect_construction_script`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_blueprint.inspect_function`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |

#### `manage_blueprint.inspect_graph`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `include_nodes` | boolean | no |  |
| `include_pins` | boolean | no |  |

#### `manage_blueprint.inspect_macro`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `macro_library` | string | no |  |
| `library_path` | string | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |

#### `manage_blueprint.list_graphs`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `include_subgraphs` | boolean | no |  |

#### `manage_blueprint.list_macros`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `macro_library` | string | no |  |
| `library_path` | string | no |  |
| `query` | string | no |  |

#### `manage_blueprint.read`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `include_nodes` | boolean | no |  |

#### `manage_blueprint.remove_local_variable`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `variable_name` | string | no |  |
| `force` | boolean | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.rename_function`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `new_name` | string | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.rename_macro`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `macro_library` | string | no |  |
| `library_path` | string | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `new_name` | string | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.reset_construction_script`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `keep_parent_call` | boolean | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.save`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_blueprint.set_blueprint_property`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `property_name` | string | yes |  |
| `property_value` | any | no |  |

#### `manage_blueprint.set_component_property`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `component_name` | string | yes |  |
| `property_name` | string | yes |  |
| `property_value` | any | no |  |

#### `manage_blueprint.set_function_signature`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `add_inputs` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `add_outputs` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `remove_pins` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `rename_pins` | array | no | array of object {from, name, to, new_name} |
|   `[].from` | string | no |  |
|   `[].name` | string | no |  |
|   `[].to` | string | no |  |
|   `[].new_name` | string | no |  |
| `flags` | array | no | one of: object, array; array of string |
| `meta` | object | no |  |
| `category` | string | no |  |
| `tooltip` | string | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.set_macro_signature`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `macro_library` | string | no |  |
| `library_path` | string | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `add_inputs` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `add_outputs` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `remove_pins` | array | no | array of object {name, pin_name, type, pin_type, default, direction} |
|   `[].name` | string | no |  |
|   `[].pin_name` | string | no |  |
|   `[].type` | string | no |  |
|   `[].pin_type` | string | no |  |
|   `[].default` | any | no |  |
|   `[].direction` | string | no |  |
| `rename_pins` | array | no | array of object {from, name, to, new_name} |
|   `[].from` | string | no |  |
|   `[].name` | string | no |  |
|   `[].to` | string | no |  |
|   `[].new_name` | string | no |  |
| `meta` | object | no |  |
| `description` | string | no |  |
| `sync_instances` | boolean | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.set_physics_properties`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `component_name` | string | yes |  |
| `simulate_physics` | boolean | no |  |
| `gravity_enabled` | boolean | no |  |
| `mass` | number | no |  |
| `linear_damping` | number | no |  |
| `angular_damping` | number | no |  |

#### `manage_blueprint.set_pin_default`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `node_id` | string | yes |  |
| `pin` | string | yes |  |
| `value` | any | yes |  |

#### `manage_blueprint.set_static_mesh`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `component_name` | string | yes |  |
| `static_mesh` | string | no |  |
| `mesh_path` | string | no |  |

#### `manage_blueprint.set_variable_flags`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `variable_name` | string | no |  |
| `is_instance_editable` | boolean | no |  |
| `is_exposed` | boolean | no |  |

#### `manage_blueprint.update_local_variable`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `graph_id` | string | no |  |
| `graph_name` | string | no |  |
| `function_name` | string | no |  |
| `macro_name` | string | no |  |
| `variable_name` | string | no |  |
| `new_name` | string | no |  |
| `pin_type` | string | no |  |
| `variable_type` | string | no |  |
| `default_value` | any | no |  |
| `category` | string | no |  |
| `flags` | object | no |  |
| `force` | boolean | no |  |
| `compile` | boolean | no |  |

#### `manage_blueprint.verify_blueprint`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `expected` | object | no |  |
| `compile` | boolean | no |  |

### `manage_build`

Read-only build environment audit and command planning for ViteSetup, UBT, RunUAT, DDC commandlets, cache wipe, and debloat. Build execution is intentionally deferred.

#### `manage_build.audit`

No parameters.

#### `manage_build.plan`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `action` | string | yes | values: build_editor, cook, package, ddc_fill, ddc_verify, vite_setup, wipe_shader_cache, debloat |
| `archiveDir` | string | no |  |

### `manage_code`

Read-first C++ and Live Coding tooling: status, project-source read/write with backups, source inventory, build/log inspection, automation-test inventory, and supervised compile/run previews.

#### `manage_code.compile`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `confirm` | boolean | no |  |
| `waitMs` | number | no |  |

#### `manage_code.logs`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | string | no |  |
| `lines` | number | no |  |
| `filter` | string | no |  |

#### `manage_code.read_source`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |

#### `manage_code.run_tests`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `filter` | string | no |  |
| `confirm` | boolean | no |  |
| `waitMs` | number | no |  |

#### `manage_code.sources`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `filter` | string | no |  |
| `limit` | number | no |  |

#### `manage_code.status`

No parameters.

#### `manage_code.tests`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | no |  |

#### `manage_code.write_source`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |
| `content` | string | yes |  |
| `overwrite` | boolean | no |  |

### `manage_data`

Data tool namespace for searching data assets, creating common data containers, and inspecting their asset metadata.

#### `manage_data.asset_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_data.create_data_asset`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `path` | string | no |  |
| `data_asset_class` | string | no |  |
| `class_name` | string | no |  |

#### `manage_data.create_data_table`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `path` | string | no |  |
| `row_struct` | string | no |  |
| `struct` | string | no |  |

#### `manage_data.create_string_table`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `path` | string | no |  |

#### `manage_data.search_data_assets`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

### `manage_ddgi`

Inspect, validate, and edit NVIDIA RTXGI/DDGI volumes with native undo/redo.

#### `manage_ddgi.delete_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |

#### `manage_ddgi.inspect_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |

#### `manage_ddgi.list_volumes`

No parameters.

#### `manage_ddgi.spawn_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `location` | object | no | object: x, y, z |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | object: pitch, yaw, roll |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | object: x, y, z |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no | object: probe_counts, probe_max_ray_distance, probe_history_weight, probe_relocation_radius, probe_relocation_distance, probe_change_threshold, probe_irradiance_encoding_gamma, probe_distance_exponent, probe_frontface_threshold, light_multiplier, emissive_multiplier, view_bias, normal_bias, visualize_probes, visualize_probe_radiance, visualize_probe_irradiance, visualize_probe_distance |
|   `probe_counts` | object | no | object: x, y, z |
|     `x` | number | yes |  |
|     `y` | number | yes |  |
|     `z` | number | yes |  |
|   `probe_max_ray_distance` | number | no |  |
|   `probe_history_weight` | number | no |  |
|   `probe_relocation_radius` | number | no |  |
|   `probe_relocation_distance` | number | no |  |
|   `probe_change_threshold` | number | no |  |
|   `probe_irradiance_encoding_gamma` | number | no |  |
|   `probe_distance_exponent` | number | no |  |
|   `probe_frontface_threshold` | number | no |  |
|   `light_multiplier` | number | no |  |
|   `emissive_multiplier` | number | no |  |
|   `view_bias` | number | no |  |
|   `normal_bias` | number | no |  |
|   `visualize_probes` | boolean | no |  |
|   `visualize_probe_radiance` | boolean | no |  |
|   `visualize_probe_irradiance` | boolean | no |  |
|   `visualize_probe_distance` | boolean | no |  |

#### `manage_ddgi.stats`

No parameters.

#### `manage_ddgi.update_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `label` | string | no |  |
| `properties` | object | no | object: probe_counts, probe_max_ray_distance, probe_history_weight, probe_relocation_radius, probe_relocation_distance, probe_change_threshold, probe_irradiance_encoding_gamma, probe_distance_exponent, probe_frontface_threshold, light_multiplier, emissive_multiplier, view_bias, normal_bias, visualize_probes, visualize_probe_radiance, visualize_probe_irradiance, visualize_probe_distance |
|   `probe_counts` | object | no | object: x, y, z |
|     `x` | number | yes |  |
|     `y` | number | yes |  |
|     `z` | number | yes |  |
|   `probe_max_ray_distance` | number | no |  |
|   `probe_history_weight` | number | no |  |
|   `probe_relocation_radius` | number | no |  |
|   `probe_relocation_distance` | number | no |  |
|   `probe_change_threshold` | number | no |  |
|   `probe_irradiance_encoding_gamma` | number | no |  |
|   `probe_distance_exponent` | number | no |  |
|   `probe_frontface_threshold` | number | no |  |
|   `light_multiplier` | number | no |  |
|   `emissive_multiplier` | number | no |  |
|   `view_bias` | number | no |  |
|   `normal_bias` | number | no |  |
|   `visualize_probes` | boolean | no |  |
|   `visualize_probe_radiance` | boolean | no |  |
|   `visualize_probe_irradiance` | boolean | no |  |
|   `visualize_probe_distance` | boolean | no |  |

#### `manage_ddgi.validate`

No parameters.

### `manage_debug`

Editor health, plugin availability, supervisor status, log tails, recent scripts, and panic/reset controls.

#### `manage_debug.health`

No parameters.

#### `manage_debug.last_calls`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | no |  |
| `tool` | string | no |  |
| `action` | string | no |  |
| `status` | string | no | values: success, error, timeout, blocked |

#### `manage_debug.logs`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `source` | string | no | values: editor, supervisor, audit |
| `lines` | number | no |  |
| `filter` | string | no |  |

#### `manage_debug.panic`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `reason` | string | no |  |

#### `manage_debug.ping`

No parameters.

#### `manage_debug.plugins`

No parameters.

#### `manage_debug.python`

No parameters.

#### `manage_debug.refresh_plugins`

No parameters.

#### `manage_debug.remote`

No parameters.

#### `manage_debug.reset`

No parameters.

#### `manage_debug.scripts`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | no |  |
| `id` | string | no |  |

#### `manage_debug.supervisor`

No parameters.

### `manage_editor`

Editor tool namespace for run_python, console capture, enriched project/map inspection, PIE lifecycle (start_pie/stop_pie/is_pie_running) and expectations (pie_expect), screenshots, asset tab open/close/focus/list, prelude reload, and camera movement.

#### `manage_editor.cancel_async`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |

#### `manage_editor.close_asset`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | yes |  |

#### `manage_editor.console_command`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes |  |
| `log_path` | string | no |  |

#### `manage_editor.focus_asset`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | yes |  |

#### `manage_editor.get_async_result`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |

#### `manage_editor.get_console_variable`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `variable_name` | string | no |  |
| `name` | string | no |  |
| `console_variable` | string | no |  |
| `execute_for_output` | boolean | no |  |
| `log_path` | string | no |  |

#### `manage_editor.inject_key`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes |  |
| `pressed` | boolean | no |  |

#### `manage_editor.inject_mouse_button`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `button` | string | yes |  |
| `pressed` | boolean | no |  |

#### `manage_editor.inject_mouse_move`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `delta_x` | number | yes |  |
| `delta_y` | number | yes |  |

#### `manage_editor.is_pie_running`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `timeout_seconds` | number | no |  |
| `poll_interval` | number | no |  |

#### `manage_editor.list_open_assets`

No parameters.

#### `manage_editor.map_info`

No parameters.

#### `manage_editor.move_camera`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |

#### `manage_editor.open_asset`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | yes |  |
| `focus` | boolean | no |  |

#### `manage_editor.pie_expect`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `conditions` | array | yes | array of object {kind, actor_name, name, expected, tolerance, property, pattern, text, regex, case_sensitive} |
|   `[].kind` | string | yes | values: actor_exists, actor_location, property_equals, log_contains |
|   `[].actor_name` | string | no |  |
|   `[].name` | string | no |  |
|   `[].expected` | array | no | array of number |
|   `[].tolerance` | number | no |  |
|   `[].property` | string | no |  |
|   `[].pattern` | string | no |  |
|   `[].text` | string | no |  |
|   `[].regex` | boolean | no |  |
|   `[].case_sensitive` | boolean | no |  |
| `timeout_ms` | number | no |  |
| `poll_ms` | number | no |  |
| `log_path` | string | no |  |

#### `manage_editor.project_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `max_items` | number | no |  |
| `max_blueprints` | number | no |  |

#### `manage_editor.reload_preludes`

No parameters.

#### `manage_editor.run_python`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes |  |

#### `manage_editor.run_python_async`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `id` | string | no |  |
| `code` | string | yes |  |
| `timeout_seconds` | number | no |  |

#### `manage_editor.run_python_checked`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes |  |

#### `manage_editor.screenshot`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `target` | string | no | values: viewport, window |
| `destination_path` | string | no |  |
| `width` | number | no |  |
| `height` | number | no |  |

#### `manage_editor.start_pie`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `timeout_seconds` | number | no |  |
| `poll_interval` | number | no |  |

#### `manage_editor.start_pie_play`

No parameters.

#### `manage_editor.stop_pie`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `timeout_seconds` | number | no |  |
| `poll_interval` | number | no |  |

#### `manage_editor.world_outliner`

No parameters.

### `manage_editor_tool`

Editor-tool namespace for Editor Utility Widget Blueprint creation and opening as a docked editor tab.

#### `manage_editor_tool.close_editor_utility`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `widget_blueprint_path` | string | no |  |
| `widget_name` | string | no |  |

#### `manage_editor_tool.create_actor_action_utility`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `parent_class` | string | no |  |

#### `manage_editor_tool.create_asset_action_utility`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `parent_class` | string | no |  |

#### `manage_editor_tool.create_editor_utility_blueprint`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `blueprint_name` | string | no |  |
| `path` | string | no |  |
| `parent_class` | string | no |  |

#### `manage_editor_tool.create_editor_utility_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_name` | string | no |  |
| `name` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `parent_class` | string | no |  |

#### `manage_editor_tool.launch_editor_utility`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint` | string | no |  |
| `widget_blueprint_path` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `blueprint_name` | string | no |  |

#### `manage_editor_tool.list_open_editor_tools`

No parameters.

### `manage_effect`

Effects tool namespace for spawning debug-shape actors, assigning materials, tinting them, and deleting them.

#### `manage_effect.apply_material`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `material_path` | string | yes |  |
| `slot_index` | number | no |  |

#### `manage_effect.delete_debug_shape`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |

#### `manage_effect.spawn_debug_shape`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `shape` | string | no |  |
| `shape_type` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `material_path` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_effect.tint_debug_shape`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `material_path` | string | no |  |
| `slot_index` | number | no |  |
| `color` | object | no | one of: object, array; object: r, g, b, a; or array of number |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |
| `parameter_name` | string | no |  |
| `instance_name` | string | no |  |
| `instance_path` | string | no |  |

### `manage_gas`

GAS tool namespace for searching gameplay-ability-related assets and inspecting their asset metadata.

#### `manage_gas.asset_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_gas.search_gas_assets`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `asset_class` | string | no |  |
| `class_name` | string | no |  |
| `class` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

### `manage_geometry`

Geometry tool namespace for all preset builders: wall, maze, pyramid, bridge, town, house, mansion, tower, suspension bridge, aqueduct, castle fortress, arch, and staircase.

#### `manage_geometry.construct_house`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `width` | number | no |  |
| `depth` | number | no |  |
| `wall_height` | number | no |  |
| `wall_thickness` | number | no |  |
| `roof_height` | number | no |  |

#### `manage_geometry.construct_mansion`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `width` | number | no |  |
| `depth` | number | no |  |
| `wall_height` | number | no |  |
| `wall_thickness` | number | no |  |
| `roof_height` | number | no |  |
| `wing_offset` | number | no |  |

#### `manage_geometry.create_aqueduct`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `arches` | number | no |  |
| `spacing` | number | no |  |

#### `manage_geometry.create_arch`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `span_width` | number | no |  |
| `pillar_height` | number | no |  |
| `pillar_width` | number | no |  |
| `beam_height` | number | no |  |

#### `manage_geometry.create_bridge`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `segments` | number | no |  |
| `segment_length` | number | no |  |
| `width` | number | no |  |
| `thickness` | number | no |  |
| `rail_height` | number | no |  |

#### `manage_geometry.create_castle_fortress`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `size` | number | no |  |
| `segments` | number | no |  |
| `height` | number | no |  |
| `thickness` | number | no |  |
| `tower_width` | number | no |  |

#### `manage_geometry.create_maze`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `rows` | number | no |  |
| `cols` | number | no |  |
| `cell_size` | number | no |  |
| `wall_height` | number | no |  |
| `wall_thickness` | number | no |  |
| `seed` | number | no |  |

#### `manage_geometry.create_pyramid`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `levels` | number | no |  |
| `block_size` | number | no |  |

#### `manage_geometry.create_staircase`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `steps` | number | no |  |
| `step_width` | number | no |  |
| `step_height` | number | no |  |
| `step_depth` | number | no |  |

#### `manage_geometry.create_suspension_bridge`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `segments` | number | no |  |
| `segment_length` | number | no |  |
| `width` | number | no |  |
| `thickness` | number | no |  |
| `rail_height` | number | no |  |
| `tower_height` | number | no |  |

#### `manage_geometry.create_tower`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `width` | number | no |  |
| `floors` | number | no |  |
| `floor_height` | number | no |  |

#### `manage_geometry.create_town`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `rows` | number | no |  |
| `cols` | number | no |  |
| `spacing` | number | no |  |

#### `manage_geometry.create_wall`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `location` | object | no | Optional world location; one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `material_path` | string | no | Optional material path to apply |
| `prefix` | string | no | Optional actor label prefix |
| `segments` | number | no |  |
| `segment_length` | number | no |  |
| `height` | number | no |  |
| `thickness` | number | no |  |
| `axis` | string | no |  |

### `manage_history`

Action history with native editor undo/redo and semantic undo metadata.

#### `manage_history.clear`

No parameters.

#### `manage_history.get`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |

#### `manage_history.list`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | no |  |
| `tool` | string | no |  |
| `action` | string | no |  |
| `status` | string | no | values: success, error, timeout |

#### `manage_history.redo`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `targetId` | string | yes |  |

#### `manage_history.status`

No parameters.

#### `manage_history.undo`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `targetId` | string | yes |  |

### `manage_input`

Input tool namespace for creating classic UE4 input mappings.

#### `manage_input.create_input_mapping`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `mapping_name` | string | no |  |
| `action_name` | string | no |  |
| `name` | string | no |  |
| `key` | string | yes |  |
| `input_type` | string | no |  |
| `scale` | number | no |  |

### `manage_level`

Level tool namespace for map lifecycle inspection, actor listing, world outliner inspection, and map info.

#### `manage_level.info`

No parameters.

#### `manage_level.list_actors`

No parameters.

#### `manage_level.world_outliner`

No parameters.

### `manage_lighting`

Lighting tool namespace for spawning common light actors, transforming them, and inspecting level lighting state.

#### `manage_lighting.inspect_lighting`

No parameters.

#### `manage_lighting.spawn_directional_light`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |

#### `manage_lighting.spawn_point_light`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |

#### `manage_lighting.spawn_spot_light`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |

#### `manage_lighting.transform_light`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |

### `manage_material`

Material tool namespace for listing/applying materials and tinting material instances, plus Material and MaterialFunction expression-graph authoring.

#### `manage_material.add_expression`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `function_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `expression_class` | string | yes |  |
| `x` | number | no |  |
| `y` | number | no |  |
| `node_position` | array | no | array of number |
| `properties` | object | no |  |
| `save` | boolean | no |  |

#### `manage_material.add_function_output`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `function_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `output_name` | string | no |  |
| `sort_priority` | number | no |  |
| `x` | number | no |  |
| `y` | number | no |  |
| `save` | boolean | no |  |

#### `manage_material.apply_to_actor`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `material_path` | string | yes |  |
| `slot_index` | number | no |  |

#### `manage_material.apply_to_blueprint`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `component_name` | string | yes |  |
| `material_path` | string | yes |  |
| `slot_index` | number | no |  |

#### `manage_material.connect`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `function_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `source_expression` | string | yes |  |
| `target_expression` | string | yes |  |
| `source_output` | string | no |  |
| `target_input` | string | no |  |
| `save` | boolean | no |  |

#### `manage_material.connect_property`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `expression` | string | yes |  |
| `property` | string | yes |  |
| `source_output` | string | no |  |
| `save` | boolean | no |  |

#### `manage_material.create_material`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_name` | string | no |  |
| `name` | string | no |  |
| `path` | string | no |  |
| `save` | boolean | no |  |

#### `manage_material.create_material_function`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_name` | string | no |  |
| `name` | string | no |  |
| `path` | string | no |  |
| `function_type` | string | no | values: function, layer, layer_blend |
| `save` | boolean | no |  |

#### `manage_material.create_material_instance`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `parent_material` | string | no |  |
| `material_path` | string | no |  |
| `instance_name` | string | no |  |
| `asset_name` | string | no |  |
| `name` | string | no |  |
| `package_path` | string | no |  |
| `path` | string | no |  |
| `scalar_parameters` | object | no | record<number> |
| `vector_parameters` | object | no |  |

#### `manage_material.delete_expression`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `function_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `expression` | string | yes |  |
| `save` | boolean | no |  |

#### `manage_material.get_material_instance_parameters`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `instance_path` | string | no |  |
| `asset_path` | string | no |  |
| `material_instance` | string | no |  |
| `path` | string | no |  |

#### `manage_material.inspect_graph`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `function_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_material.inspect_material_instance`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_instance` | string | no |  |
| `path` | string | no |  |

#### `manage_material.layout`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `function_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_material.list_materials`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

#### `manage_material.recompile`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |

#### `manage_material.save`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `function_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_material.set_expression_property`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_path` | string | no |  |
| `function_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `expression` | string | yes |  |
| `property` | string | yes |  |
| `value` | any | yes |  |
| `save` | boolean | no |  |

#### `manage_material.set_material_instance_parameter`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_instance` | string | no |  |
| `parameter_name` | string | yes |  |
| `parameter_type` | string | no | values: scalar, float, vector, color, texture, static_switch, switch, bool |
| `value` | any | yes |  |

#### `manage_material.set_material_instance_parameters`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `instance_path` | string | no |  |
| `asset_path` | string | no |  |
| `material_instance` | string | no |  |
| `path` | string | no |  |
| `scalars` | object | no | record<number> |
| `vectors` | object | no |  |
| `textures` | object | no | record<string> |
| `static_switches` | object | no | Static switch values keyed by parameter name. true/false, 1/0, yes/no, on/off are accepted. |
| `save` | boolean | no |  |

#### `manage_material.set_material_instance_parent`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `material_instance` | string | no |  |
| `parent_material` | string | no |  |
| `material_path` | string | no |  |

#### `manage_material.tint_material`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `color` | object | no | one of: object, array; object: r, g, b, a; or array of number |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |
| `actor_name` | string | no |  |
| `name` | string | no |  |
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `component_name` | string | no |  |
| `material_path` | string | no |  |
| `slot_index` | number | no |  |
| `parameter_name` | string | no |  |
| `instance_name` | string | no |  |
| `instance_path` | string | no |  |

### `manage_navigation`

Navigation tool namespace for spawning navigation volumes and proxies plus basic map inspection actions.

#### `manage_navigation.inspect_navigation`

No parameters.

#### `manage_navigation.spawn_nav_link_proxy`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `object_class` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_navigation.spawn_nav_mesh_bounds_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `object_class` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_navigation.spawn_nav_modifier_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `object_class` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

### `manage_object`

Generic UObject control: describe schema, read/write any property path, call functions, spawn by class path, destroy, duplicate, and run transactional batches.

#### `manage_object.apply`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `operations` | array | yes | array of object {action, params} |
|   `[].action` | string | yes |  |
|   `[].params` | object | no |  |
| `label` | string | no |  |
| `dry_run` | boolean | no |  |
| `world` | string | no | values: editor, pie |

#### `manage_object.call`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | no | Handle from a previous result: 'uev:<kind>:<object path>' is stable (survives releases, PIE transitions and editor restarts). Legacy 'obj_<n>' is still accepted but only stays valid until the retained-object registry is released. |
| `target` | string | no |  |
| `selector` | object | no |  |
| `world` | string | no | values: editor, pie |
| `function` | string | yes |  |
| `args` | array | no | array of any |

#### `manage_object.describe`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | no | Handle from a previous result: 'uev:<kind>:<object path>' is stable (survives releases, PIE transitions and editor restarts). Legacy 'obj_<n>' is still accepted but only stays valid until the retained-object registry is released. |
| `target` | string | no |  |
| `selector` | object | no |  |
| `world` | string | no | values: editor, pie |
| `class` | string | no |  |
| `values` | boolean | no |  |
| `functions` | boolean | no |  |

#### `manage_object.destroy`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | no | Handle from a previous result: 'uev:<kind>:<object path>' is stable (survives releases, PIE transitions and editor restarts). Legacy 'obj_<n>' is still accepted but only stays valid until the retained-object registry is released. |
| `target` | string | no |  |
| `selector` | object | no |  |
| `world` | string | no | values: editor, pie |

#### `manage_object.duplicate`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | no | Handle from a previous result: 'uev:<kind>:<object path>' is stable (survives releases, PIE transitions and editor restarts). Legacy 'obj_<n>' is still accepted but only stays valid until the retained-object registry is released. |
| `target` | string | no |  |
| `selector` | object | no |  |
| `world` | string | no | values: editor, pie |
| `count` | number | no |  |
| `offset` | any | no |  |

#### `manage_object.ensure`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `class` | string | yes |  |
| `label` | string | no |  |
| `name` | string | no |  |
| `location` | any | no |  |
| `rotation` | any | no |  |
| `scale` | any | no |  |
| `folder` | string | no |  |
| `properties` | object | no |  |
| `world` | string | no | values: editor, pie |

#### `manage_object.get`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | no | Handle from a previous result: 'uev:<kind>:<object path>' is stable (survives releases, PIE transitions and editor restarts). Legacy 'obj_<n>' is still accepted but only stays valid until the retained-object registry is released. |
| `target` | string | no |  |
| `selector` | object | no |  |
| `world` | string | no | values: editor, pie |
| `path` | string | yes |  |

#### `manage_object.release_handles`

No parameters.

#### `manage_object.set`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | no | Handle from a previous result: 'uev:<kind>:<object path>' is stable (survives releases, PIE transitions and editor restarts). Legacy 'obj_<n>' is still accepted but only stays valid until the retained-object registry is released. |
| `target` | string | no |  |
| `selector` | object | no |  |
| `world` | string | no | values: editor, pie |
| `path` | string | yes |  |
| `value` | any | yes |  |
| `dry_run` | boolean | no |  |

#### `manage_object.spawn`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `class` | string | yes |  |
| `label` | string | no |  |
| `name` | string | no |  |
| `location` | any | no |  |
| `rotation` | any | no |  |
| `scale` | any | no |  |
| `folder` | string | no |  |
| `properties` | object | no |  |
| `world` | string | no | values: editor, pie |

### `manage_physics`

Physics tool namespace for spawning physics-enabled Blueprints, editing component physics, applying forces and impulses in PIE, setting collision profile/response and CharacterMovement properties, and running a bounded PIE drop test.

#### `manage_physics.add_force`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `target` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `force` | object | yes | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `bone_name` | string | no |  |
| `accel_change` | boolean | no |  |

#### `manage_physics.add_impulse`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `target` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `impulse` | object | yes | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `bone_name` | string | no |  |
| `vel_change` | boolean | no |  |

#### `manage_physics.add_torque`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `target` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `torque` | object | yes | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `bone_name` | string | no |  |
| `accel_change` | boolean | no |  |

#### `manage_physics.pie_drop_test`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `actor_class` | string | no |  |
| `class_name` | string | no |  |
| `target` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | yes | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `height` | number | no |  |
| `settle_seconds` | number | no |  |
| `frames` | number | no |  |
| `expected_ground_z` | number | no |  |
| `simulate_physics` | boolean | no |  |
| `gravity` | boolean | no |  |
| `component_name` | string | no |  |
| `label` | string | no |  |

#### `manage_physics.set_character_movement`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `target` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `max_walk_speed` | number | no |  |
| `jump_z_velocity` | number | no |  |
| `gravity_scale` | number | no |  |
| `air_control` | number | no |  |
| `braking_deceleration` | number | no |  |
| `ground_friction` | number | no |  |
| `max_step_height` | number | no |  |
| `walkable_floor_angle` | number | no |  |
| `save` | boolean | no |  |

#### `manage_physics.set_collision_profile`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `target` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `profile_name` | string | yes |  |
| `save` | boolean | no |  |

#### `manage_physics.set_collision_response`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `target` | string | no |  |
| `actor_name` | string | no |  |
| `component_name` | string | no |  |
| `channel` | string | yes | values: Visibility, Camera, WorldStatic, WorldDynamic, Pawn, PhysicsBody, Vehicle, Destructible |
| `response` | string | yes | values: ignore, overlap, block |
| `save` | boolean | no |  |

#### `manage_physics.set_physics_properties`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `save` | boolean | no |  |
| `component_name` | string | yes |  |
| `simulate_physics` | boolean | no |  |
| `gravity_enabled` | boolean | no |  |
| `mass` | number | no |  |
| `linear_damping` | number | no |  |
| `angular_damping` | number | no |  |

#### `manage_physics.spawn_physics_blueprint_actor`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `component_name` | string | no |  |
| `material_path` | string | no |  |
| `slot_index` | number | no |  |
| `simulate_physics` | boolean | no |  |
| `gravity_enabled` | boolean | no |  |
| `mass` | number | no |  |
| `linear_damping` | number | no |  |
| `angular_damping` | number | no |  |

### `manage_profile`

Profiling capture with stats-file artifacts, artifact listing/inspection, log comparison, frame-budget checks, and supervised profilegpu capture.

#### `manage_profile.artifact_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes |  |

#### `manage_profile.budget_check`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `frameTimeMs` | number | yes |  |
| `targetFps` | number | yes |  |

#### `manage_profile.capture_frame`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `waitMs` | number | no |  |

#### `manage_profile.capture_stats`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `stats` | array | no | array of string |
| `durationMs` | number | no |  |

#### `manage_profile.compare`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `beforeFrameTimeMs` | number | yes |  |
| `afterFrameTimeMs` | number | yes |  |
| `targetFps` | number | no |  |

#### `manage_profile.list_artifacts`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | no |  |
| `extension` | string | no | values: .ue4stats, .stats, .csv, .txt, .json |

### `manage_query`

Find objects in the level or assets by class, label, tag, component or asset reference. Each result carries a stable 'uev:<kind>:<object path>' handle for manage_object plus the numeric 'native_handle' (obj_<n>).

#### `manage_query.query`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `class` | string | no |  |
| `label` | string | no |  |
| `tag` | string | no |  |
| `component` | string | no |  |
| `asset_ref` | string | no |  |
| `path` | string | no |  |
| `world` | string | no | values: editor, pie |
| `limit` | number | no |  |
| `offset` | number | no |  |
| `compact` | boolean | no |  |

### `manage_sequence`

Sequence tool namespace for creating, searching, inspecting, and editing LevelSequence assets, including bindings, tracks, sections, keys, camera cuts, playback ranges, and speed-track time calculations.

#### `manage_sequence.add_camera_cut`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `binding_id` | string | no |  |
| `binding_name` | string | no |  |
| `actor_name` | string | no |  |
| `actor_path` | string | no |  |
| `object_path` | string | no |  |
| `camera_actor_name` | string | no |  |
| `start_frame` | number | no |  |
| `end_frame` | number | no |  |
| `duration_frames` | number | no |  |
| `start_seconds` | number | no |  |
| `end_seconds` | number | no |  |
| `duration_seconds` | number | no |  |
| `unbounded` | boolean | no |  |
| `save` | boolean | no |  |

#### `manage_sequence.add_key`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `scope` | string | no | values: master, binding |
| `master` | boolean | no |  |
| `track_type` | string | no |  |
| `track_index` | number | no |  |
| `track_name` | string | no |  |
| `binding_id` | string | no |  |
| `binding_name` | string | no |  |
| `actor_name` | string | no |  |
| `actor_path` | string | no |  |
| `object_path` | string | no |  |
| `camera_actor_name` | string | no |  |
| `section_index` | number | no |  |
| `channel_type` | string | no |  |
| `channel_name` | string | no |  |
| `channel_index` | number | no |  |
| `frame` | number | no |  |
| `time_seconds` | number | no |  |
| `seconds` | number | no |  |
| `sub_frame` | number | no |  |
| `time_unit` | string | no | values: display_rate, tick_resolution |
| `value` | any | no |  |
| `save` | boolean | no |  |

#### `manage_sequence.add_section`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `scope` | string | no | values: master, binding |
| `master` | boolean | no |  |
| `track_type` | string | no |  |
| `track_index` | number | no |  |
| `track_name` | string | no |  |
| `binding_id` | string | no |  |
| `binding_name` | string | no |  |
| `actor_name` | string | no |  |
| `actor_path` | string | no |  |
| `object_path` | string | no |  |
| `camera_actor_name` | string | no |  |
| `start_frame` | number | no |  |
| `end_frame` | number | no |  |
| `duration_frames` | number | no |  |
| `start_seconds` | number | no |  |
| `end_seconds` | number | no |  |
| `duration_seconds` | number | no |  |
| `unbounded` | boolean | no |  |
| `save` | boolean | no |  |

#### `manage_sequence.add_track`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `scope` | string | no | values: master, binding |
| `master` | boolean | no |  |
| `track_type` | string | yes |  |
| `track_index` | number | no |  |
| `track_name` | string | no |  |
| `binding_id` | string | no |  |
| `binding_name` | string | no |  |
| `actor_name` | string | no |  |
| `actor_path` | string | no |  |
| `object_path` | string | no |  |
| `camera_actor_name` | string | no |  |
| `start_frame` | number | no |  |
| `end_frame` | number | no |  |
| `duration_frames` | number | no |  |
| `start_seconds` | number | no |  |
| `end_seconds` | number | no |  |
| `duration_seconds` | number | no |  |
| `unbounded` | boolean | no |  |
| `save` | boolean | no |  |
| `display_name` | string | no |  |
| `property_name` | string | no |  |
| `property_path` | string | no |  |
| `add_section` | boolean | no |  |

#### `manage_sequence.analyze_playback_speed`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `target_seconds` | number | no |  |
| `target_frame` | number | no |  |
| `start_seconds` | number | no |  |
| `integration_mode` | string | no | values: linear, constant |

#### `manage_sequence.bind_actor`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `actor_path` | string | no |  |
| `object_path` | string | no |  |
| `binding_name` | string | no |  |
| `reuse_existing` | boolean | no |  |
| `save` | boolean | no |  |

#### `manage_sequence.calculate_playback_time`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `target_seconds` | number | no |  |
| `target_frame` | number | no |  |
| `end_seconds` | number | no |  |
| `end_frame` | number | no |  |
| `start_seconds` | number | no |  |
| `integration_mode` | string | no | values: linear, constant |

#### `manage_sequence.convert_time`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `seconds` | number | no |  |
| `display_frame` | number | no |  |
| `tick_frame` | number | no |  |
| `frame` | number | no |  |

#### `manage_sequence.create_sequence`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `asset_name` | string | no |  |
| `path` | string | no |  |

#### `manage_sequence.inspect_sequence`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `include_channels` | boolean | no |  |
| `include_keys` | boolean | no |  |
| `key_limit` | number | no |  |

#### `manage_sequence.search_sequences`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `asset_class` | string | no |  |
| `class_name` | string | no |  |
| `class` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

#### `manage_sequence.sequence_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_sequence.sequence_support`

No parameters.

#### `manage_sequence.set_playback_range`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sequence_path` | string | no |  |
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |
| `start_frame` | number | no |  |
| `end_frame` | number | no |  |
| `duration_frames` | number | no |  |
| `start_seconds` | number | no |  |
| `end_seconds` | number | no |  |
| `duration_seconds` | number | no |  |
| `unbounded` | boolean | no |  |
| `save` | boolean | no |  |

### `manage_skeleton`

Skeleton tool namespace for searching Skeleton and SkeletalMesh assets and inspecting their metadata.

#### `manage_skeleton.asset_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

#### `manage_skeleton.search_skeletal_meshes`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `asset_class` | string | no |  |
| `class_name` | string | no |  |
| `class` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

#### `manage_skeleton.search_skeletons`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `asset_class` | string | no |  |
| `class_name` | string | no |  |
| `class` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

### `manage_source_control`

Source-control tool namespace for provider inspection and file or package source-control operations.

#### `manage_source_control.add`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

#### `manage_source_control.checkout`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

#### `manage_source_control.checkout_or_add`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

#### `manage_source_control.delete`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

#### `manage_source_control.provider_info`

No parameters.

#### `manage_source_control.query_state`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

#### `manage_source_control.query_states`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

#### `manage_source_control.revert`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

#### `manage_source_control.revert_and_reload_packages`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `packages` | array | no | array of string |
| `package_names` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `package` | string | no |  |
| `path` | string | no |  |
| `revert_all` | boolean | no |  |
| `reload_world` | boolean | no |  |

#### `manage_source_control.revert_unchanged`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

#### `manage_source_control.submit`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |
| `description` | string | no |  |
| `message` | string | no |  |
| `keep_checked_out` | boolean | no |  |

#### `manage_source_control.sync`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `files` | array | no | array of string |
| `paths` | array | no | array of string |
| `asset_paths` | array | no | array of string |
| `packages` | array | no | array of string |
| `file` | string | no |  |
| `path` | string | no |  |
| `asset_path` | string | no |  |
| `package` | string | no |  |
| `name` | string | no |  |

### `manage_splines`

Spline tool namespace for spawning a spline-host actor or Blueprint and then transforming or deleting it.

#### `manage_splines.delete_actor`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |

#### `manage_splines.spawn_actor`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `blueprint_name` | string | no |  |
| `asset_path` | string | no |  |
| `object_class` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_splines.transform_actor`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |

### `manage_stack`

Bring the Unreal editor, supervisor, and control API up on demand, attach to a running editor, inspect readiness, or stop the processes this server started.

#### `manage_stack.config`

No parameters.

#### `manage_stack.ensure`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `mode` | string | no | values: auto, attach, launch, restart |
| `wait_seconds` | number | no |  |

#### `manage_stack.relaunch`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `build` | boolean | no |  |
| `discard` | boolean | no |  |
| `wait_seconds` | number | no |  |

#### `manage_stack.status`

No parameters.

#### `manage_stack.stop`

No parameters.

### `manage_system`

Polling helper namespace: wait_for repeats another tool action until a dotted JSON path matches an expected value.

#### `manage_system.compatibility`

No parameters.

#### `manage_system.wait_for`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `predicate` | object | yes | object: tool, action, params |
|   `tool` | string | yes |  |
|   `action` | string | no |  |
|   `params` | object | no |  |
| `path` | string | no |  |
| `equals` | any | no |  |
| `timeout_ms` | number | no |  |
| `interval_ms` | number | no |  |

### `manage_texture`

Texture tool namespace for searching texture assets, importing image files as textures, and reading their asset metadata.

#### `manage_texture.import_texture`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `source_file` | string | no |  |
| `file_path` | string | no |  |
| `local_path` | string | no |  |
| `destination_path` | string | no |  |
| `content_path` | string | no |  |
| `path` | string | no |  |
| `asset_name` | string | no |  |
| `name` | string | no |  |
| `replace_existing` | boolean | no |  |
| `save` | boolean | no |  |

#### `manage_texture.search_textures`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `search_term` | string | no |  |
| `query` | string | no |  |
| `pattern` | string | no |  |
| `name` | string | no |  |
| `asset_class` | string | no |  |
| `class_name` | string | no |  |
| `class` | string | no |  |
| `include_engine` | boolean | no |  |
| `limit` | number | no |  |

#### `manage_texture.texture_info`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `asset_path` | string | no |  |
| `path` | string | no |  |
| `name` | string | no |  |

### `manage_tools`

Tool-namespace registry for listing registered tool namespaces and describing supported actions. Use this as the discovery entry point for the namespace-first MCP surface.

#### `manage_tools.describe_namespace`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `tool_name` | string | no |  |
| `namespace_name` | string | no |  |
| `name` | string | no |  |

#### `manage_tools.list_namespaces`

No parameters.

#### `manage_tools.tool_status`

No parameters.

### `manage_vite`

Unreal Engine Vite renderer inspection and controlled writes: cvars, render state, compile switches, presets, project audit, and allowlisted console commands.

#### `manage_vite.capabilities`

No parameters.

#### `manage_vite.compile_switches`

No parameters.

#### `manage_vite.console`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | values: stat unit, stat gpu, stat scenerendering, stat physics, stat memory, profilegpu |

#### `manage_vite.cvar_catalog`

No parameters.

#### `manage_vite.cvar_get`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |

#### `manage_vite.cvar_restore`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `value` | any | yes | one of: boolean, number |

#### `manage_vite.cvar_set`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `value` | any | yes | one of: boolean, number |

#### `manage_vite.preset_apply`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |

#### `manage_vite.preset_list`

No parameters.

#### `manage_vite.preset_preview`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |

#### `manage_vite.preset_restore`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `values` | object | yes |  |

#### `manage_vite.project_audit`

No parameters.

#### `manage_vite.render_state`

No parameters.

### `manage_volumes`

Volume tool namespace for spawning common engine volumes and applying delete or transform actions.

#### `manage_volumes.delete_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |

#### `manage_volumes.spawn_audio_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `object_class` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_volumes.spawn_blocking_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `object_class` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_volumes.spawn_physics_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `object_class` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_volumes.spawn_trigger_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `object_class` | string | no |  |
| `class_name` | string | no |  |
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `properties` | object | no |  |

#### `manage_volumes.transform_volume`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `actor_name` | string | no |  |
| `location` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |
| `rotation` | object | no | one of: object, array; object: pitch, yaw, roll; or array of number |
|   `pitch` | number | yes |  |
|   `yaw` | number | yes |  |
|   `roll` | number | yes |  |
| `scale` | object | no | one of: object, array; object: x, y, z; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
|   `z` | number | yes |  |

### `manage_widget`

Widget tool namespace for UMG Blueprint creation, widget-tree inspection, widget-tree edits, CanvasPanel root normalization, and viewport spawning actions. Use inspect_tree to verify designer contents, add_child_widget for nested layout work, and ensure_canvas_root when absolute CanvasPanel positioning is required.

#### `manage_widget.add_button`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint` | string | no |  |
| `widget_blueprint_path` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `blueprint_name` | string | no |  |
| `button_name` | string | no |  |
| `name` | string | no |  |
| `text` | string | no |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `font_size` | number | no |  |
| `z_order` | number | no |  |
| `color` | object | no | one of: object, array; object: r, g, b, a; or array of number |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |
| `background_color` | object | no | one of: object, array; object: r, g, b, a; or array of number |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |

#### `manage_widget.add_child_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `parent_widget_name` | string | yes |  |
| `child_widget_class` | string | yes |  |
| `child_widget_name` | string | no |  |
| `name` | string | no |  |
| `text` | string | no |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `z_order` | number | no |  |
| `font_size` | number | no |  |
| `color` | object | no | one of: object, array; object: r, g, b, a; or array of number |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |
| `background_color` | object | no | one of: object, array; object: r, g, b, a; or array of number |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |

#### `manage_widget.add_panel`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `panel_type` | string | yes |  |
| `panel_name` | string | yes |  |
| `parent_widget_name` | string | no |  |

#### `manage_widget.add_text_block`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint` | string | no |  |
| `widget_blueprint_path` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `blueprint_name` | string | no |  |
| `text_block_name` | string | no |  |
| `name` | string | no |  |
| `text` | string | no |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `font_size` | number | no |  |
| `z_order` | number | no |  |
| `color` | object | no | one of: object, array; object: r, g, b, a; or array of number |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |

#### `manage_widget.add_to_viewport`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint` | string | no |  |
| `widget_blueprint_path` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `blueprint_name` | string | no |  |
| `z_order` | number | no |  |
| `start_pie_if_needed` | boolean | no |  |
| `auto_start_pie` | boolean | no |  |
| `timeout_seconds` | number | no |  |
| `poll_interval` | number | no |  |

#### `manage_widget.add_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_class` | string | yes |  |
| `widget_name` | string | no |  |
| `name` | string | no |  |
| `parent_widget_name` | string | no |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `z_order` | number | no |  |
| `background_color` | object | no | one of: object, array; object: r, g, b, a; or array of number |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |

#### `manage_widget.bind_event`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |
| `event_name` | string | yes |  |
| `function_name` | string | no |  |

#### `manage_widget.create_widget_blueprint`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_name` | string | no |  |
| `name` | string | no |  |
| `asset_path` | string | no |  |
| `widget_path` | string | no |  |
| `parent_class` | string | no |  |
| `path` | string | no |  |

#### `manage_widget.designer_screenshot`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `width` | number | no |  |
| `height` | number | no |  |
| `output_path` | string | no |  |

#### `manage_widget.duplicate_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |
| `new_name` | string | no |  |
| `duplicate_name` | string | no |  |
| `deep` | boolean | no |  |

#### `manage_widget.ensure_canvas_root`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint` | string | no |  |
| `widget_blueprint_path` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `blueprint_name` | string | no |  |
| `root_widget_name` | string | no |  |
| `root_name` | string | no |  |
| `wrap_existing_root` | boolean | no |  |

#### `manage_widget.insert_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_class` | string | yes |  |
| `widget_name` | string | no |  |
| `name` | string | no |  |
| `widget_member_name` | string | no |  |
| `parent_widget_name` | string | no |  |
| `parent` | string | no |  |
| `index` | number | no |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `z_order` | number | no |  |

#### `manage_widget.inspect_selection`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |

#### `manage_widget.inspect_tree`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint` | string | no |  |
| `widget_blueprint_path` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `blueprint_name` | string | no |  |

#### `manage_widget.list_bound_events`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |

#### `manage_widget.list_delegates`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |
| `class_name` | string | no |  |

#### `manage_widget.list_events`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |

#### `manage_widget.position_child_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `parent_widget_name` | string | yes |  |
| `child_widget_name` | string | no |  |
| `name` | string | no |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `z_order` | number | no |  |

#### `manage_widget.position_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `name` | string | no |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `z_order` | number | no |  |

#### `manage_widget.release_viewport_widgets`

No parameters.

#### `manage_widget.remove_child_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `parent_widget_name` | string | yes |  |
| `child_widget_name` | string | no |  |
| `name` | string | no |  |

#### `manage_widget.remove_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `name` | string | no |  |

#### `manage_widget.rename_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |
| `new_name` | string | yes |  |
| `retarget_bindings` | boolean | no |  |

#### `manage_widget.reorder_child`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |
| `index` | number | yes |  |

#### `manage_widget.reparent_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `name` | string | no |  |
| `new_parent_widget_name` | string | yes |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `z_order` | number | no |  |

#### `manage_widget.serialize_tree`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `include_slot` | boolean | no |  |

#### `manage_widget.set_alignment`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `alignment` | object | yes | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |

#### `manage_widget.set_anchors`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `anchor_preset` | string | no |  |
| `preset` | string | no |  |
| `minimum` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `maximum` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |

#### `manage_widget.set_brush`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |
| `property` | string | no |  |
| `brush` | object | no |  |
| `texture_path` | string | no |  |
| `material_path` | string | no |  |
| `draw_as` | string | no |  |
| `margin` | any | no | one of: number, object |
| `tint` | object | no | object: r, g, b, a |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |
| `image_size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `match_size` | boolean | no |  |

#### `manage_widget.set_offsets`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `left` | number | no |  |
| `top` | number | no |  |
| `right` | number | no |  |
| `bottom` | number | no |  |
| `position` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `size` | object | no | one of: object, array; object: x, y; or array of number |
|   `x` | number | yes |  |
|   `y` | number | yes |  |

#### `manage_widget.set_padding`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `left` | number | no |  |
| `top` | number | no |  |
| `right` | number | no |  |
| `bottom` | number | no |  |

#### `manage_widget.set_size`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `size` | object | yes | values: fill, auto, automatic; one of: string, object; object: x, y |
|   `x` | number | yes |  |
|   `y` | number | yes |  |

#### `manage_widget.set_slot`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `padding` | object | no | object: left, top, right, bottom |
|   `left` | number | yes |  |
|   `top` | number | yes |  |
|   `right` | number | yes |  |
|   `bottom` | number | yes |  |
| `horizontal_alignment` | string | no |  |
| `vertical_alignment` | string | no |  |
| `size` | object | no | values: fill, auto, automatic; one of: string, object; object: x, y |
|   `x` | number | yes |  |
|   `y` | number | yes |  |
| `row` | number | no |  |
| `column` | number | no |  |
| `row_span` | number | no |  |
| `column_span` | number | no |  |
| `z_order` | number | no |  |

#### `manage_widget.set_style`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |
| `style` | object | no |  |
| `font` | object | no |  |
| `brush` | object | no |  |
| `states` | object | no |  |
| `color` | object | no | object: r, g, b, a |
|   `r` | number | yes |  |
|   `g` | number | yes |  |
|   `b` | number | yes |  |
|   `a` | number | no |  |
| `font_size` | number | no |  |

#### `manage_widget.set_text_block_binding`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint` | string | no |  |
| `widget_blueprint_path` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `blueprint_name` | string | no |  |
| `text_block_name` | string | yes |  |
| `binding_property` | string | no |  |
| `function_name` | string | no |  |
| `source_property` | string | no |  |

#### `manage_widget.set_widget_property`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_name` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `property` | string | yes |  |
| `value` | array | yes | one of: string, number, boolean, array, object; array of number |

#### `manage_widget.unbind_event`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |
| `widget_member_name` | string | no |  |
| `widget_component_name` | string | no |  |
| `widget_name` | string | no |  |
| `event_name` | string | yes |  |
| `function_name` | string | no |  |
| `remove_function_graph` | boolean | no |  |

#### `manage_widget.validate_widget`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `widget_blueprint_path` | string | no |  |
| `widget_blueprint` | string | no |  |
| `widget_path` | string | no |  |
| `asset_path` | string | no |  |

