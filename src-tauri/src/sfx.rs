use rodio::{Decoder, OutputStream, Sink};
use std::io::BufReader;
use std::path::PathBuf;

/// Play a sound effect by name. Non-blocking (spawns a thread).
/// Names: "start" → start-quite.wav, "complete" → complete-accomplish.wav
pub fn play(name: &str, assets_dir: &PathBuf) {
    let filename = match name {
        "start" => "start-quite.wav",
        "complete" => "complete-accomplish.wav",
        _ => {
            eprintln!("SFX: unknown sound '{}'", name);
            return;
        }
    };

    let path = assets_dir.join(filename);
    if !path.exists() {
        eprintln!("SFX: file not found: {:?}", path);
        return;
    }

    std::thread::spawn(move || {
        let Ok((_stream, stream_handle)) = OutputStream::try_default() else {
            eprintln!("SFX: no audio output");
            return;
        };
        let Ok(file) = std::fs::File::open(&path) else {
            eprintln!("SFX: can't open {:?}", path);
            return;
        };
        let Ok(source) = Decoder::new(BufReader::new(file)) else {
            eprintln!("SFX: can't decode {:?}", path);
            return;
        };
        let Ok(sink) = Sink::try_new(&stream_handle) else {
            eprintln!("SFX: can't create sink");
            return;
        };
        sink.append(source);
        sink.sleep_until_end();
    });
}
