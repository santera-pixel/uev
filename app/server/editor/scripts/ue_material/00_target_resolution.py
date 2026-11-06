def _resolve_actor_and_component(args):
    actor_name = args.get("actor_name")
    component_name = args.get("component_name")
    actor = find_actor_by_name(actor_name)
    if not actor:
        raise ValueError("Actor not found: {0}".format(actor_name))

    component = find_actor_material_component(actor, component_name)
    return actor, component


def _get_blueprint_component(blueprint_name, component_name):
    blueprint = load_blueprint_asset(blueprint_name)
    component_node, component_template = get_component_template(blueprint, component_name)
    return blueprint, component_node, component_template
