"""Read-only bounded NUT protocol client. No USB access or control commands."""
import asyncio
import shlex


async def read_vars(host, port, alias):
    writer = None
    try:
        async with asyncio.timeout(8):
            reader, writer = await asyncio.open_connection(host, port, limit=16384)
            writer.write(f"LIST VAR {alias}\n".encode("ascii"))
            await writer.drain()
            if (await reader.readline()).decode().strip() != f"BEGIN LIST VAR {alias}":
                raise ValueError("NUT data unavailable")
            values = {}
            for _ in range(512):
                line = (await reader.readline()).decode("utf-8").strip()
                if line == f"END LIST VAR {alias}":
                    if not values.get("ups.status"):
                        raise ValueError("NUT status is missing")
                    return values
                parts = shlex.split(line)
                if len(parts) != 4 or parts[:2] != ["VAR", alias]:
                    raise ValueError("Invalid or incomplete NUT response")
                values[parts[2]] = parts[3]
            raise ValueError("NUT response exceeds the limit")
    finally:
        if writer is not None:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 1)
            except (OSError, TimeoutError):
                pass
