
import os
import uuid
import zipfile
import threading
import subprocess
import sys
from pathlib import Path

from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    send_file,
    abort,
    url_for,
)

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024

jobs = {}
jobs_lock = threading.Lock()

ALLOWED_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}


def update_job(job_id, **changes):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(changes)


def get_job(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        return dict(job) if job else None


def process_audio(job_id, input_path):
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        update_job(job_id, status="processing", progress=10,
                   message="Preparing audio...")

        command = [
            sys.executable,
            "-m",
            "demucs",
            "--name",
            "htdemucs",
            "--out",
            str(job_dir),
            str(input_path),
        ]

        update_job(job_id, progress=20,
                   message="AI is separating the audio...")

        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=60 * 60,
        )

        if result.returncode != 0:
            raise RuntimeError(
                result.stderr[-3000:] or "Demucs could not process this file."
            )

        vocal_files = list(job_dir.rglob("vocals.wav"))
        if not vocal_files:
            raise RuntimeError("The AI finished, but no vocals stem was found.")

        model_folder = vocal_files[0].parent
        stems = []

        for stem_name in ("vocals", "drums", "bass", "other"):
            stem_path = model_folder / f"{stem_name}.wav"
            if stem_path.exists():
                stems.append({
                    "name": stem_name,
                    "label": {
                        "vocals": "Vocals",
                        "drums": "Drums",
                        "bass": "Bass",
                        "other": "Other / Instrumental Parts",
                    }[stem_name],
                    "url": url_for(
                        "get_stem",
                        job_id=job_id,
                        filename=stem_path.name,
                    ),
                })

        if not stems:
            raise RuntimeError("No separated audio files were found.")

        zip_path = job_dir / "stems.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for stem in stems:
                archive.write(
                    model_folder / f"{stem['name']}.wav",
                    arcname=f"{stem['name']}.wav",
                )

        update_job(
            job_id,
            status="complete",
            progress=100,
            message="Separation complete!",
            stems=stems,
            zip_url=url_for("download_zip", job_id=job_id),
        )

    except subprocess.TimeoutExpired:
        update_job(
            job_id,
            status="error",
            message="Processing took too long and was stopped.",
        )
    except Exception as exc:
        update_job(
            job_id,
            status="error",
            message=str(exc),
        )
    finally:
        try:
            input_path.unlink(missing_ok=True)
        except OSError:
            pass


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/separate", methods=["POST"])
def separate():
    if "audio" not in request.files:
        return jsonify({"error": "Please select an audio file."}), 400

    audio = request.files["audio"]

    if not audio.filename:
        return jsonify({"error": "Please select an audio file."}), 400

    extension = Path(audio.filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        return jsonify({
            "error": "Unsupported file type. Use WAV, MP3, FLAC, OGG or M4A."
        }), 400

    job_id = uuid.uuid4().hex
    upload_path = UPLOAD_DIR / f"{job_id}{extension}"

    try:
        audio.save(upload_path)
    except Exception:
        upload_path.unlink(missing_ok=True)
        return jsonify({"error": "Could not save the uploaded file."}), 500

    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "message": "Waiting to start...",
            "stems": [],
        }

    thread = threading.Thread(
        target=process_audio,
        args=(job_id, upload_path),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id}), 202


@app.route("/api/status/<job_id>")
def job_status(job_id):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found."}), 404
    return jsonify(job)


@app.route("/stems/<job_id>/<filename>")
def get_stem(job_id, filename):
    if not filename.endswith(".wav") or Path(filename).name != filename:
        abort(400)

    file_path = OUTPUT_DIR / job_id
    matches = list(file_path.rglob(filename)) if file_path.exists() else []

    if not matches:
        abort(404)

    return send_file(matches[0], mimetype="audio/wav")


@app.route("/download/<job_id>")
def download_zip(job_id):
    job = get_job(job_id)
    if not job or job.get("status") != "complete":
        abort(404)

    zip_path = OUTPUT_DIR / job_id / "stems.zip"
    if not zip_path.exists():
        abort(404)

    return send_file(
        zip_path,
        mimetype="application/zip",
        as_attachment=True,
        download_name="separated_stems.zip",
    )


@app.errorhandler(413)
def file_too_large(_error):
    return jsonify({
        "error": "File too large. The maximum upload size is 200 MB."
    }), 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
