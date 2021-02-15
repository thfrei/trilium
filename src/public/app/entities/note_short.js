import server from '../services/server.js';
import noteAttributeCache from "../services/note_attribute_cache.js";
import ws from "../services/ws.js";
import options from "../services/options.js";

const LABEL = 'label';
const RELATION = 'relation';

const NOTE_TYPE_ICONS = {
    "file": "bx bx-file",
    "image": "bx bx-image",
    "code": "bx bx-code",
    "render": "bx bx-extension",
    "search": "bx bx-file-find",
    "relation-map": "bx bx-map-alt",
    "canvas-note": "bx bx-pen",
    "book": "bx bx-book"
};

/**
 * FIXME: since there's no "full note" anymore we can rename this to Note
 *
 * This note's representation is used in note tree and is kept in TreeCache.
 */
class NoteShort {
    /**
     * @param {TreeCache} treeCache
     * @param {Object.<string, Object>} row
     */
    constructor(treeCache, row) {
        this.treeCache = treeCache;

        /** @type {string[]} */
        this.attributes = [];

        /** @type {string[]} */
        this.targetRelations = [];

        /** @type {string[]} */
        this.parents = [];
        /** @type {string[]} */
        this.children = [];

        /** @type {Object.<string, string>} */
        this.parentToBranch = {};

        /** @type {Object.<string, string>} */
        this.childToBranch = {};

        this.update(row);
    }

    update(row) {
        /** @param {string} */
        this.noteId = row.noteId;
        /** @param {string} */
        this.title = row.title;
        /** @param {boolean} */
        this.isProtected = !!row.isProtected;
        /** @param {string} one of 'text', 'code', 'file' or 'render' */
        this.type = row.type;
        /** @param {string} content-type, e.g. "application/json" */
        this.mime = row.mime;
        /** @param {boolean} */
        this.isDeleted = !!row.isDeleted;
    }

    addParent(parentNoteId, branchId) {
        if (parentNoteId === 'none') {
            return;
        }

        if (!this.parents.includes(parentNoteId)) {
            this.parents.push(parentNoteId);
        }

        this.parentToBranch[parentNoteId] = branchId;
    }

    addChild(childNoteId, branchId, sort = true) {
        if (!(childNoteId in this.childToBranch)) {
            this.children.push(childNoteId);
        }

        this.childToBranch[childNoteId] = branchId;

        if (sort) {
            this.sortChildren();
        }
    }

    sortChildren() {
        const branchIdPos = {};

        for (const branchId of Object.values(this.childToBranch)) {
            branchIdPos[branchId] = this.treeCache.getBranch(branchId).notePosition;
        }

        this.children.sort((a, b) => branchIdPos[this.childToBranch[a]] < branchIdPos[this.childToBranch[b]] ? -1 : 1);
    }

    /** @returns {boolean} */
    isJson() {
        return this.mime === "application/json";
    }

    async getContent() {
        // we're not caching content since these objects are in treeCache and as such pretty long lived
        const note = await server.get("notes/" + this.noteId);

        return note.content;
    }

    async getJsonContent() {
        const content = await this.getContent();

        try {
            return JSON.parse(content);
        }
        catch (e) {
            console.log(`Cannot parse content of note ${this.noteId}: `, e.message);

            return null;
        }
    }

    /** @returns {string[]} */
    getBranchIds() {
        return Object.values(this.parentToBranch);
    }

    /** @returns {Branch[]} */
    getBranches() {
        const branchIds = Object.values(this.parentToBranch);

        return this.treeCache.getBranches(branchIds);
    }

    /** @returns {boolean} */
    hasChildren() {
        return this.children.length > 0;
    }

    /** @returns {Branch[]} */
    getChildBranches() {
        // don't use Object.values() to guarantee order
        const branchIds = this.children.map(childNoteId => this.childToBranch[childNoteId]);

        return this.treeCache.getBranches(branchIds);
    }

    /** @returns {string[]} */
    getParentNoteIds() {
        return this.parents;
    }

    /** @returns {NoteShort[]} */
    getParentNotes() {
        return this.treeCache.getNotesFromCache(this.parents);
    }

    /** @returns {string[]} */
    getChildNoteIds() {
        return this.children;
    }

    /** @returns {Promise<NoteShort[]>} */
    async getChildNotes() {
        return await this.treeCache.getNotes(this.children);
    }

    /**
     * @param {string} [type] - (optional) attribute type to filter
     * @param {string} [name] - (optional) attribute name to filter
     * @returns {Attribute[]} all note's attributes, including inherited ones
     */
    getOwnedAttributes(type, name) {
        const attrs = this.attributes
            .map(attributeId => this.treeCache.attributes[attributeId])
            .filter(Boolean); // filter out nulls;

        return this.__filterAttrs(attrs, type, name);
    }

    /**
     * @param {string} [type] - (optional) attribute type to filter
     * @param {string} [name] - (optional) attribute name to filter
     * @returns {Attribute[]} all note's attributes, including inherited ones
     */
    getAttributes(type, name) {
        return this.__filterAttrs(this.__getCachedAttributes([]), type, name);
    }

    __getCachedAttributes(path) {
        // notes/clones cannot form tree cycles, it is possible to create attribute inheritance cycle via templates
        // when template instance is a parent of template itself
        if (path.includes(this.noteId)) {
            return [];
        }

        if (!(this.noteId in noteAttributeCache.attributes)) {
            const newPath = [...path, this.noteId];
            const attrArrs = [ this.getOwnedAttributes() ];

            if (this.noteId !== 'root') {
                for (const parentNote of this.getParentNotes()) {
                    // these virtual parent-child relationships are also loaded into frontend tree cache
                    if (parentNote.type !== 'search') {
                        attrArrs.push(parentNote.__getInheritableAttributes(newPath));
                    }
                }
            }

            for (const templateAttr of attrArrs.flat().filter(attr => attr.type === 'relation' && attr.name === 'template')) {
                const templateNote = this.treeCache.notes[templateAttr.value];

                if (templateNote && templateNote.noteId !== this.noteId) {
                    attrArrs.push(templateNote.__getCachedAttributes(newPath));
                }
            }

            noteAttributeCache.attributes[this.noteId] = [];
            const addedAttributeIds = new Set();

            for (const attr of attrArrs.flat()) {
                if (!addedAttributeIds.has(attr.attributeId)) {
                    addedAttributeIds.add(attr.attributeId);

                    noteAttributeCache.attributes[this.noteId].push(attr);
                }
            }
        }

        return noteAttributeCache.attributes[this.noteId];
    }

    __filterAttrs(attributes, type, name) {
        if (!type && !name) {
            return attributes;
        } else if (type && name) {
            return attributes.filter(attr => attr.type === type && attr.name === name);
        } else if (type) {
            return attributes.filter(attr => attr.type === type);
        } else if (name) {
            return attributes.filter(attr => attr.name === name);
        }
    }

    __getInheritableAttributes(path) {
        const attrs = this.__getCachedAttributes(path);

        return attrs.filter(attr => attr.isInheritable);
    }

    /**
     * @param {string} [name] - label name to filter
     * @returns {Attribute[]} all note's labels (attributes with type label), including inherited ones
     */
    getOwnedLabels(name) {
        return this.getOwnedAttributes(LABEL, name);
    }

    /**
     * @param {string} [name] - label name to filter
     * @returns {Attribute[]} all note's labels (attributes with type label), including inherited ones
     */
    getLabels(name) {
        return this.getAttributes(LABEL, name);
    }

    getIcon() {
        const iconClassLabels = this.getLabels('iconClass');
        const workspaceIconClass = this.getWorkspaceIconClass();

        if (iconClassLabels.length > 0) {
            return iconClassLabels.map(l => l.value).join(' ');
        }
        else if (workspaceIconClass) {
            return workspaceIconClass;
        }
        else if (this.noteId === 'root') {
            return "bx bx-chevrons-right";
        }
        else if (this.type === 'text') {
            if (this.isFolder()) {
                return "bx bx-folder";
            }
            else {
                return "bx bx-note";
            }
        }
        else if (this.type === 'code' && this.mime.startsWith('text/x-sql')) {
            return "bx bx-data";
        }
        else {
            return NOTE_TYPE_ICONS[this.type];
        }
    }

    isFolder() {
        return this.type === 'search'
            || this.getFilteredChildBranches().length > 0;
    }

    getFilteredChildBranches() {
        let childBranches = this.getChildBranches();

        if (!childBranches) {
            ws.logError(`No children for ${parentNote}. This shouldn't happen.`);
            return;
        }

        if (options.is("hideIncludedImages_main")) {
            const imageLinks = this.getRelations('imageLink');

            // image is already visible in the parent note so no need to display it separately in the book
            childBranches = childBranches.filter(branch => !imageLinks.find(rel => rel.value === branch.noteId));
        }

        // we're not checking hideArchivedNotes since that would mean we need to lazy load the child notes
        // which would seriously slow down everything.
        // we check this flag only once user chooses to expand the parent. This has the negative consequence that
        // note may appear as folder but not contain any children when all of them are archived

        return childBranches;
    }

    /**
     * @param {string} [name] - relation name to filter
     * @returns {Attribute[]} all note's relations (attributes with type relation), including inherited ones
     */
    getOwnedRelations(name) {
        return this.getOwnedAttributes(RELATION, name);
    }

    /**
     * @param {string} [name] - relation name to filter
     * @returns {Attribute[]} all note's relations (attributes with type relation), including inherited ones
     */
    getRelations(name) {
        return this.getAttributes(RELATION, name);
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {boolean} true if note has an attribute with given type and name (including inherited)
     */
    hasAttribute(type, name) {
        return !!this.getAttribute(type, name);
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {boolean} true if note has an attribute with given type and name (including inherited)
     */
    hasOwnedAttribute(type, name) {
        return !!this.getOwnedAttribute(type, name);
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {Attribute} attribute of given type and name. If there's more such attributes, first is  returned. Returns null if there's no such attribute belonging to this note.
     */
    getOwnedAttribute(type, name) {
        const attributes = this.getOwnedAttributes(type, name);

        return attributes.length > 0 ? attributes[0] : 0;
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {Attribute} attribute of given type and name. If there's more such attributes, first is  returned. Returns null if there's no such attribute belonging to this note.
     */
    getAttribute(type, name) {
        const attributes = this.getAttributes(type, name);

        return attributes.length > 0 ? attributes[0] : null;
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {string} attribute value of given type and name or null if no such attribute exists.
     */
    getOwnedAttributeValue(type, name) {
        const attr = this.getOwnedAttribute(type, name);

        return attr ? attr.value : null;
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {string} attribute value of given type and name or null if no such attribute exists.
     */
    getAttributeValue(type, name) {
        const attr = this.getAttribute(type, name);

        return attr ? attr.value : null;
    }

    /**
     * @param {string} name - label name
     * @returns {boolean} true if label exists (excluding inherited)
     */
    hasOwnedLabel(name) { return this.hasOwnedAttribute(LABEL, name); }

    /**
     * @param {string} name - label name
     * @returns {boolean} true if label exists (including inherited)
     */
    hasLabel(name) { return this.hasAttribute(LABEL, name); }

    /**
     * @param {string} name - relation name
     * @returns {boolean} true if relation exists (excluding inherited)
     */
    hasOwnedRelation(name) { return this.hasOwnedAttribute(RELATION, name); }

    /**
     * @param {string} name - relation name
     * @returns {boolean} true if relation exists (including inherited)
     */
    hasRelation(name) { return this.hasAttribute(RELATION, name); }

    /**
     * @param {string} name - label name
     * @returns {Attribute} label if it exists, null otherwise
     */
    getOwnedLabel(name) { return this.getOwnedAttribute(LABEL, name); }

    /**
     * @param {string} name - label name
     * @returns {Attribute} label if it exists, null otherwise
     */
    getLabel(name) { return this.getAttribute(LABEL, name); }

    /**
     * @param {string} name - relation name
     * @returns {Attribute} relation if it exists, null otherwise
     */
    getOwnedRelation(name) { return this.getOwnedAttribute(RELATION, name); }

    /**
     * @param {string} name - relation name
     * @returns {Attribute} relation if it exists, null otherwise
     */
    getRelation(name) { return this.getAttribute(RELATION, name); }

    /**
     * @param {string} name - label name
     * @returns {string} label value if label exists, null otherwise
     */
    getOwnedLabelValue(name) { return this.getOwnedAttributeValue(LABEL, name); }

    /**
     * @param {string} name - label name
     * @returns {string} label value if label exists, null otherwise
     */
    getLabelValue(name) { return this.getAttributeValue(LABEL, name); }

    /**
     * @param {string} name - relation name
     * @returns {string} relation value if relation exists, null otherwise
     */
    getOwnedRelationValue(name) { return this.getOwnedAttributeValue(RELATION, name); }

    /**
     * @param {string} name - relation name
     * @returns {string} relation value if relation exists, null otherwise
     */
    getRelationValue(name) { return this.getAttributeValue(RELATION, name); }

    /**
     * @param {string} name
     * @returns {Promise<NoteShort>|null} target note of the relation or null (if target is empty or note was not found)
     */
    async getRelationTarget(name) {
        const targets = await this.getRelationTargets(name);

        return targets.length > 0 ? targets[0] : null;
    }

    /**
     * @param {string} [name] - relation name to filter
     * @returns {Promise<NoteShort[]>}
     */
    async getRelationTargets(name) {
        const relations = this.getRelations(name);
        const targets = [];

        for (const relation of relations) {
            targets.push(await this.treeCache.getNote(relation.value));
        }

        return targets;
    }

    /**
     * @returns {NoteShort[]}
     */
    getTemplateNotes() {
        const relations = this.getRelations('template');

        return relations.map(rel => this.treeCache.notes[rel.value]);
    }

    getPromotedDefinitionAttributes() {
        if (this.hasLabel('hidePromotedAttributes')) {
            return [];
        }

        return this.getAttributes()
            .filter(attr => attr.isDefinition())
            .filter(attr => {
                const def = attr.getDefinition();

                return def && def.isPromoted;
            });
    }

    hasAncestor(ancestorNote, visitedNoteIds) {
        if (this.noteId === ancestorNote.noteId) {
            return true;
        }

        if (!visitedNoteIds) {
            visitedNoteIds = new Set();
        } else if (visitedNoteIds.has(this.noteId)) {
            // to avoid infinite cycle when template is descendent of the instance
            return false;
        }

        visitedNoteIds.add(this.noteId);

        for (const templateNote of this.getTemplateNotes()) {
            if (templateNote.hasAncestor(ancestorNote, visitedNoteIds)) {
                return true;
            }
        }

        for (const parentNote of this.getParentNotes()) {
            if (parentNote.hasAncestor(ancestorNote, visitedNoteIds)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Clear note's attributes cache to force fresh reload for next attribute request.
     * Cache is note instance scoped.
     */
    invalidateAttributeCache() {
        this.__attributeCache = null;
    }

    /**
     * Get relations which target this note
     *
     * @returns {Attribute[]}
     */
    getTargetRelations() {
        return this.targetRelations
            .map(attributeId => this.treeCache.attributes[attributeId]);
    }

    /**
     * Get relations which target this note
     *
     * @returns {NoteShort[]}
     */
    async getTargetRelationSourceNotes() {
        const targetRelations = this.getTargetRelations();

        return await this.treeCache.getNotes(targetRelations.map(tr => tr.noteId));
    }

    /**
     * Return note complement which is most importantly note's content
     *
     * @return {Promise<NoteComplement>}
     */
    async getNoteComplement() {
        return await this.treeCache.getNoteComplement(this.noteId);
    }

    get toString() {
        return `Note(noteId=${this.noteId}, title=${this.title})`;
    }

    get dto() {
        const dto = Object.assign({}, this);
        delete dto.treeCache;

        return dto;
    }

    getCssClass() {
        const labels = this.getLabels('cssClass');
        return labels.map(l => l.value).join(' ');
    }

    getWorkspaceIconClass() {
        const labels = this.getLabels('workspaceIconClass');
        return labels.length > 0 ? labels[0].value : "";
    }

    getWorkspaceTabBackgroundColor() {
        const labels = this.getLabels('workspaceTabBackgroundColor');
        return labels.length > 0 ? labels[0].value : "";
    }
}

export default NoteShort;
