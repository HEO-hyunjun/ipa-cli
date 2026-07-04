from ipa_cli.api import Mapping


mapping = Mapping(
    note_type="kind",
    refs="parents",
    tags="tags",
    created_at="created",
    updated_at="updated",
    aliases="aliases",
    custom={
        "stage": "stage",
        "pattern": "pattern",
        "special": "special",
    },
)

