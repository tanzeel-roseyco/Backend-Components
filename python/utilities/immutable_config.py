"""
Immutable Configuration Container
Single source of truth for all application configuration.
Prevents runtime mutations and provides type-safe access.
"""

from dataclasses import dataclass, fields, asdict
from typing import Any, Dict, Optional, get_type_hints
import os


@dataclass(frozen=True)
class ImmutableConfig:
    """Frozen configuration dataclass - immutable at runtime"""

    def __post_init__(self):
        """Validate configuration after initialization"""
        pass

    @classmethod
    def from_env(cls, prefix: str = "", **defaults):
        """Create config from environment variables"""
        config_data = {}

        # Get type hints for validation
        hints = get_type_hints(cls)

        # Process each field
        for field in fields(cls):
            env_key = f"{prefix}_{field.name}".upper() if prefix else field.name.upper()
            env_value = os.getenv(env_key)

            if env_value is not None:
                # Coerce value to correct type
                config_data[field.name] = cls._coerce_value(env_value, field.type)
            elif field.name in defaults:
                config_data[field.name] = defaults[field.name]
            elif field.default is not None:
                config_data[field.name] = field.default
            elif field.default_factory is not None:  # type: ignore
                config_data[field.name] = field.default_factory()  # type: ignore
            else:
                raise ValueError(f"Missing required config: {env_key}")

        return cls(**config_data)

    @staticmethod
    def _coerce_value(value: str, target_type: type) -> Any:
        """Coerce environment variable string to correct type"""
        if target_type == str:
            return value
        elif target_type == int:
            try:
                return int(value)
            except ValueError:
                raise ValueError(f"Cannot coerce '{value}' to int")
        elif target_type == float:
            try:
                return float(value)
            except ValueError:
                raise ValueError(f"Cannot coerce '{value}' to float")
        elif target_type == bool:
            return value.lower() in ("true", "1", "yes")
        elif target_type == list:
            return [s.strip() for s in value.split(",")]
        else:
            return value

    def validate(self) -> Dict[str, Any]:
        """Validate all fields are set"""
        errors = {}
        for field in fields(self):
            value = getattr(self, field.name)
            if value is None:
                errors[field.name] = "Required field is None"

        return {
            "valid": len(errors) == 0,
            "errors": errors,
        }

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary (immutable copy)"""
        return asdict(self)

    def get(self, key: str, default: Any = None) -> Any:
        """Get configuration value by key"""
        try:
            return getattr(self, key)
        except AttributeError:
            return default


# Example configuration
@dataclass(frozen=True)
class AppConfig(ImmutableConfig):
    """Application configuration"""

    # Database
    database_url: str
    database_pool_size: int = 10

    # Redis
    redis_url: str
    redis_password: Optional[str] = None

    # API
    api_url: str
    api_timeout: int = 30
    max_retries: int = 3

    # Features
    debug: bool = False
    enable_caching: bool = True
    cache_ttl: int = 3600


# Usage example:
# config = AppConfig.from_env(
#     prefix="APP",
#     debug=False,
#     defaults={"enable_caching": True}
# )
#
# # In production
# config = AppConfig.from_env(prefix="PROD")
# database_url = config.database_url  # Immutable - cannot modify
# config.database_url = "new_url"  # This would raise FrozenInstanceError
