"""Install a pinned, checksum-verified official CLI inside the ignored local directory."""
import hashlib
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / ".local-database/bin/supabase"
VERSION = "2.75.0"
# Official v2.75.0 checksums, fetched over verified HTTPS from supabase/cli releases.
CHECKSUMS = {
    "linux_amd64": "e5597462f865d5ac72af0453358e37ecb0d85962ad6914a114a53de847303bde",
    "linux_arm64": "b551c2f8e03715be428d2592765200a9e371168fc36ec2646a84ecc530d3120e",
    "darwin_amd64": "dce985af1fec522babf216f86cdf53701b45387393dea1ddd6401119c44eba32",
    "darwin_arm64": "6618736487287a9f0835c44a7101694deb4ca1192852a070a93014437641cea3",
}


def install():
    system = platform.system().lower()
    arch = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    target = f"{system}_{arch}"
    if target not in CHECKSUMS:
        raise RuntimeError("Supported CLI platforms: Linux/macOS amd64 and arm64")
    with tempfile.TemporaryDirectory(prefix="waseet-cli-") as directory:
        archive = Path(directory) / "cli.tar.gz"
        url = f"https://github.com/supabase/cli/releases/download/v{VERSION}/supabase_{target}.tar.gz"
        subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location", url, "--output", str(archive)], check=True)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != CHECKSUMS[target]:
            raise RuntimeError("CLI archive checksum mismatch; installation refused")
        with tarfile.open(archive) as tar:
            member = tar.getmember("supabase")
            if not member.isfile():
                raise RuntimeError("Unexpected CLI archive member")
            CLI.parent.mkdir(parents=True, exist_ok=True)
            # Extract only the exact executable, never archive paths or symlinks.
            CLI.write_bytes(tar.extractfile(member).read())
            CLI.chmod(0o755)
    result = subprocess.run([str(CLI), "--version"], check=True, text=True, capture_output=True)
    if result.stdout.strip() != VERSION:
        raise RuntimeError("Unexpected CLI version")
    print(f"Installed official Supabase CLI {VERSION} (archive SHA-256 verified)")
    return CLI


if __name__ == "__main__":
    install()
