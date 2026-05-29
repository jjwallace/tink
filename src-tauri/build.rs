use std::env;
use std::path::PathBuf;

fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }

    // ── Link prebuilt creature-core static lib ─────────────────
    //
    // The IP (choreography + orchestrator state machine) ships as a
    // prebuilt static library from the private companion repo. We link
    // the right .a for the build target. Anyone cloning tink can build
    // without needing companion access — the binary lives committed in
    // `vendor/<target>/libcreature_core.a`.
    //
    // To rebuild: from `companion/creature-core/`, run
    //   cargo build --release --target <target>
    // then copy `target/<target>/release/libcreature_core.a` into
    // tink's `vendor/<target>/`.
    let target = env::var("TARGET").unwrap_or_default();
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor_dir = manifest_dir.join("vendor").join(&target);
    if vendor_dir.exists() {
        println!("cargo:rustc-link-search=native={}", vendor_dir.display());
        println!("cargo:rustc-link-lib=static=creature_core");
        println!("cargo:rerun-if-changed={}", vendor_dir.display());
    } else {
        println!(
            "cargo:warning=No prebuilt creature-core for target {}. Looked in {}",
            target,
            vendor_dir.display()
        );
    }

    tauri_build::build()
}
