"""Configure one stable NUT endpoint."""
import voluptuous as vol
from homeassistant import config_entries
from .nut import read_vars
from .policy import identity


class AdapterConfigFlow(config_entries.ConfigFlow, domain="usb_ups_adapter"):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            await self.async_set_unique_id(f"{user_input['host']}:{user_input['port']}/{user_input['alias']}")
            self._abort_if_unique_id_configured()
            try:
                identity(await read_vars(**{key: user_input[key] for key in ("host", "port", "alias")}))
            except (OSError, TimeoutError, ValueError):
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title="USB UPS Adapter", data=user_input)
        return self.async_show_form(step_id="user", data_schema=vol.Schema({
            vol.Required("host", default="192.168.50.200"): str,
            vol.Required("port", default=3493): vol.All(vol.Coerce(int), vol.Range(min=1, max=65535)),
            vol.Required("alias", default="ups"): vol.Match(r"^[a-zA-Z0-9_-]{1,64}$"),
            vol.Optional("legacy_entry"): str,
        }), errors=errors)
