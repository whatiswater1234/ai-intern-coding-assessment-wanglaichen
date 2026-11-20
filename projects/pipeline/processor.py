def analyze_chunk(values):
    return {"count": len(values), "checksum": sum(v * (i + 1) for i, v in enumerate(values))}
