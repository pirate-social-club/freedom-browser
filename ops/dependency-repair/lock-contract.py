"""Reject unrelated manifest, production graph or test-tool drift."""
import copy

JEST_VERSION = "30.3.0"
REMAINING_ADVISORY = "https://github.com/advisories/GHSA-ch52-4w7c-c8xp"


def require(value, code):
    if not value:
        raise ValueError(code)


def candidate_manifest(original):
    candidate = copy.deepcopy(original)
    for name in ("jest", "babel-jest"):
        require(name in candidate["devDependencies"], "missing_jest_root")
        candidate["devDependencies"][name] = JEST_VERSION
    return candidate


def production_entries(lock):
    return {path: entry for path, entry in lock["packages"].items()
            if path and entry.get("dev") is not True}


def resolve_package(packages, parent, name):
    while True:
        path = (parent + "/" if parent else "") + "node_modules/" + name
        if path in packages:
            return path
        if not parent:
            return None
        parent = parent.rsplit("/node_modules/", 1)[0] if "/node_modules/" in parent else ""


def resolved_graph(lock, roots):
    packages = lock["packages"]
    pending = [resolve_package(packages, "", name) for name in roots]
    require(None not in pending, "missing_root_package")
    graph = {}
    while pending:
        path = pending.pop()
        if path in graph:
            continue
        entry = packages[path]
        edges = {}
        for kind in ("dependencies", "optionalDependencies", "peerDependencies"):
            for name in entry.get(kind, {}):
                child = resolve_package(packages, path, name)
                edges[kind + ":" + name] = child
                if child:
                    pending.append(child)
        graph[path] = {"entry": entry, "resolved_edges": edges}
    return graph


def validate_lock(original_manifest, original_lock, manifest, lock):
    require(manifest == candidate_manifest(original_manifest), "unrelated_manifest_change")
    require(lock.get("lockfileVersion") == original_lock.get("lockfileVersion") == 3,
            "lock_schema")
    for key in ("name", "version", "requires"):
        require(lock.get(key) == original_lock.get(key), "lock_metadata_changed")
    root = copy.deepcopy(original_lock["packages"][""])
    for name in ("jest", "babel-jest"):
        root["devDependencies"][name] = JEST_VERSION
        entry = lock["packages"].get("node_modules/" + name, {})
        require(entry.get("version") == JEST_VERSION and entry.get("dev") is True,
                "jest_version")
        require(entry.get("resolved") == "https://registry.npmjs.org/" + name
                + "/-/" + name + "-" + JEST_VERSION + ".tgz"
                and isinstance(entry.get("integrity"), str)
                and entry["integrity"].startswith("sha512-"), "jest_origin")
    require(lock["packages"].get("") == root, "root_lock_changed")
    require(production_entries(lock) == production_entries(original_lock),
            "production_graph_changed")
    other_roots = set()
    for kind in ("dependencies", "optionalDependencies", "devDependencies"):
        other_roots.update(original_manifest.get(kind, {}))
    other_roots.difference_update(("jest", "babel-jest"))
    require(resolved_graph(lock, other_roots) == resolved_graph(original_lock, other_roots),
            "unrelated_dependency_graph_changed")
    before_jest = resolved_graph(original_lock, ("jest", "babel-jest"))
    after_jest = resolved_graph(lock, ("jest", "babel-jest"))
    # Reject nested copies and retained incoming edges, too.
    for path, entry in lock["packages"].items():
        require(path.rsplit("node_modules/", 1)[-1] not in ("braces", "micromatch")
                and entry.get("name") not in ("braces", "micromatch"),
                "affected_test_package_retained")
        for kind in ("dependencies", "optionalDependencies", "peerDependencies"):
            require(not {"braces", "micromatch"}.intersection(entry.get(kind, {})),
                    "affected_test_edge_retained")
            require(not any(isinstance(spec, str) and spec.startswith(("npm:braces@", "npm:micromatch@"))
                            for spec in entry.get(kind, {}).values()), "affected_test_edge_retained")
    changes = []
    for path in sorted(set(original_lock["packages"]) | set(lock["packages"])):
        before, after = original_lock["packages"].get(path), lock["packages"].get(path)
        if path and before != after:
            require((before is None or path in before_jest) and (after is None or path in after_jest),
                    "unrelated_lock_entry_changed")
            changes.append({"path": path, "before": before, "after": after})
    require(bool(changes), "no_lock_update")
    return changes


def audit_observation(audit, returncode):
    require(returncode in (0, 1) and isinstance(audit, dict) and "error" not in audit,
            "audit_protocol_failed")
    findings = audit.get("vulnerabilities")
    require(isinstance(findings, dict), "audit_schema")
    resolved = {}

    def resolve(name, ancestry):
        require(isinstance(name, str) and name in findings, "audit_reference_missing")
        require(name not in ancestry, "audit_reference_cycle")
        if name in resolved:
            return resolved[name]
        entry = findings[name]
        require(isinstance(entry, dict) and isinstance(entry.get("via"), list),
                "audit_finding_schema")
        roots = set()
        for via in entry["via"]:
            if isinstance(via, dict):
                require(isinstance(via.get("url"), str), "audit_advisory_schema")
                roots.add(via["url"])
            else:
                roots.update(resolve(via, ancestry | {name}))
        require(bool(roots), "audit_reference_without_advisory")
        resolved[name] = roots
        return roots

    roots = set()
    for name in findings:
        roots.update(resolve(name, set()))
    require(roots <= {REMAINING_ADVISORY}, "new_or_retained_advisory")
    require((returncode == 0) == (not findings), "audit_verdict_inconsistent")
    return {"exit_code": returncode, "full_audit_passed": returncode == 0,
            "advisories": sorted(roots), "dependency_entries": len(findings),
            "audit_gate_changed": False}
