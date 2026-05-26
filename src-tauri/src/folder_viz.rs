use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    /// "file" or "dir"
    pub kind: String,
    /// git status: "added", "modified", "deleted", "untracked", "clean", "ignored"
    pub status: String,
    pub children: Vec<FolderNode>,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct FolderSummary {
    pub root: FolderNode,
    pub total_files: usize,
    pub total_dirs: usize,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub untracked: usize,
    pub description: String,
}

/// Get git status for all files in a repo.
fn git_status_map(dir: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();

    let output = std::process::Command::new("git")
        .args(["status", "--porcelain", "-u"])
        .current_dir(dir)
        .output();

    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.len() < 4 {
                continue;
            }
            let status_code = &line[..2];
            let file_path = line[3..].trim().to_string();
            // Remove quotes if present
            let file_path = file_path.trim_matches('"').to_string();

            let status = match status_code.trim() {
                "A" | "A " => "added",
                "M" | "M " | " M" | "MM" => "modified",
                "D" | "D " | " D" => "deleted",
                "??" => "untracked",
                "R" | "R " => "modified",
                _ => "modified",
            };
            map.insert(file_path, status.to_string());
        }
    }

    map
}

/// Recursively build the folder tree.
fn build_tree(
    dir: &Path,
    root: &Path,
    git_map: &std::collections::HashMap<String, String>,
    depth: usize,
    max_depth: usize,
) -> Option<FolderNode> {
    if depth > max_depth {
        return None;
    }

    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.to_string_lossy().to_string());

    // Skip hidden dirs and common noise
    if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" || name == ".git" {
        return None;
    }

    let rel_path = dir
        .strip_prefix(root)
        .unwrap_or(dir)
        .to_string_lossy()
        .to_string();

    if dir.is_file() {
        let status = git_map.get(&rel_path).cloned().unwrap_or("clean".into());
        let size = dir.metadata().map(|m| m.len()).unwrap_or(0);
        return Some(FolderNode {
            name,
            path: rel_path,
            kind: "file".into(),
            status,
            children: vec![],
            size,
        });
    }

    if dir.is_dir() {
        let mut children = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                if let Some(child) = build_tree(&entry.path(), root, git_map, depth + 1, max_depth) {
                    children.push(child);
                }
            }
        }

        // Determine directory status from children
        let has_modified = children.iter().any(|c| c.status == "modified" || c.status == "added" || c.status == "untracked");
        let status = if has_modified { "modified" } else { "clean" };

        return Some(FolderNode {
            name,
            path: rel_path,
            kind: "dir".into(),
            status: status.into(),
            children,
            size: 0,
        });
    }

    None
}

/// Scan a folder and return the tree with summary.
pub fn scan(dir: &str, max_depth: usize) -> Result<FolderSummary, String> {
    let path = Path::new(dir);
    if !path.exists() {
        return Err(format!("Path does not exist: {}", dir));
    }

    let git_map = git_status_map(path);
    let root = build_tree(path, path, &git_map, 0, max_depth)
        .ok_or("Failed to build tree")?;

    // Count stats
    fn count(node: &FolderNode) -> (usize, usize, usize, usize, usize, usize) {
        let mut files = 0;
        let mut dirs = 0;
        let mut added = 0;
        let mut modified = 0;
        let mut deleted = 0;
        let mut untracked = 0;

        if node.kind == "file" {
            files += 1;
            match node.status.as_str() {
                "added" => added += 1,
                "modified" => modified += 1,
                "deleted" => deleted += 1,
                "untracked" => untracked += 1,
                _ => {}
            }
        } else {
            dirs += 1;
        }

        for child in &node.children {
            let (f, d, a, m, del, u) = count(child);
            files += f;
            dirs += d;
            added += a;
            modified += m;
            deleted += del;
            untracked += u;
        }

        (files, dirs, added, modified, deleted, untracked)
    }

    let (total_files, total_dirs, added, modified, deleted, untracked) = count(&root);

    let mut desc_parts = vec![format!("{} files, {} folders", total_files, total_dirs)];
    if added > 0 { desc_parts.push(format!("{} added", added)); }
    if modified > 0 { desc_parts.push(format!("{} modified", modified)); }
    if deleted > 0 { desc_parts.push(format!("{} deleted", deleted)); }
    if untracked > 0 { desc_parts.push(format!("{} new", untracked)); }

    Ok(FolderSummary {
        root,
        total_files,
        total_dirs,
        added,
        modified,
        deleted,
        untracked,
        description: desc_parts.join(", "),
    })
}
