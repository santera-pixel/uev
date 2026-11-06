def _vector_from_list(values, default=None):
    values = values or default or [0.0, 0.0, 0.0]
    return unreal.Vector(x=float(values[0]), y=float(values[1]), z=float(values[2]))


def _rotator_from_list(values, default=None):
    values = values or default or [0.0, 0.0, 0.0]
    return unreal.Rotator(
        pitch=float(values[0]),
        yaw=float(values[1]),
        roll=float(values[2]),
    )
