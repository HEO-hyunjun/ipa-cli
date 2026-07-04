from rules.archive_flat_rule import ArchiveFlatRule
from rules.frontmatter_kind_rule import FrontmatterKindRule
from rules.project_note_rule import ProjectNoteRule


rules = [
    FrontmatterKindRule(),
    ProjectNoteRule(),
    ArchiveFlatRule(),
]

