"""Model token categories and quantity rules shared by provider extractors.

Extractors write only the base categories in ``MODEL_USAGE_CATEGORIES``.
Model-provider reporting may remap those keys to reporter-owned billing
categories after selecting a tier.
"""

from .json_selective import ScalarField
from .quantities import MAX_USAGE_QUANTITY, is_positive_usage_quantity, is_usage_quantity

MODEL_USAGE_CATEGORY_INPUT = "tokens.input"
MODEL_USAGE_CATEGORY_OUTPUT = "tokens.output"
MODEL_USAGE_CATEGORY_CACHE_READ = "tokens.cache_read"
MODEL_USAGE_CATEGORY_CACHE_CREATION = "tokens.cache_creation"

MODEL_USAGE_IDENTITY_FIELD = ScalarField("string", max_bytes=1024)
MODEL_USAGE_QUANTITY_FIELD = ScalarField("int", max_bytes=64, max_int_value=MAX_USAGE_QUANTITY)

# Canonical normalized category keys accepted from provider extractors.
MODEL_USAGE_CATEGORIES = (
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
)


def has_positive_model_provider_usage(source_usage: dict) -> bool:
    """Return whether a normalized model usage source has a positive token count."""
    for category in MODEL_USAGE_CATEGORIES:
        if is_positive_usage_quantity(source_usage.get(category)):
            return True
    return False


def update_model_usage_quantity(target: dict, category: str, value: object) -> None:
    """Apply a positive-wins model usage update to one normalized category.

    Provider updates may report zero after an earlier positive quantity. Preserve
    the recorded value in that case, while retaining zero for a missing category.
    """
    if is_usage_quantity(value) and (value > 0 or category not in target):
        target[category] = value


ANTHROPIC_USAGE_FIELD_CATEGORIES = {
    "input_tokens": MODEL_USAGE_CATEGORY_INPUT,
    "output_tokens": MODEL_USAGE_CATEGORY_OUTPUT,
    "cache_read_input_tokens": MODEL_USAGE_CATEGORY_CACHE_READ,
    "cache_creation_input_tokens": MODEL_USAGE_CATEGORY_CACHE_CREATION,
}
