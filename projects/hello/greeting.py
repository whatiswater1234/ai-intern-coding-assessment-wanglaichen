def greet(name="World"):
    cleaned = (name or "").strip() or "World"
    return f"Hello, {cleaned}!"


def format_release_banner(service_name, version):
    return f"[{service_name} v{version}] ready"
