"""Assemble the verified CPython base and an Android wheel installation for Gradle."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile
from tempfile import TemporaryDirectory
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED


CPYTHON_SHA256 = "423c80b957330cf0ebb92b9b20f2294c292144a441bdb0ceb8c69d14928e569b"
STDLIB = "python3.14"
LIBRARIES = (
    "libpython3.14.so",
    "libpython3.so",
    "libssl_python.so",
    "libcrypto_python.so",
    "libsqlite3_python.so",
)
REQUIRED = ("asyncpg", "psycopg2", "pydantic_core", "uvicorn", "toktok_rs", "numpy", "orjson")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cpython", type=Path, help="Python 3.14.10 aarch64-linux-android release archive")
    parser.add_argument("site_packages", type=Path, help="Installed CPython 3.14 Android arm64 dependencies")
    parser.add_argument("clang", type=Path, help="NDK aarch64-linux-android26-clang")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.cpython.read_bytes()).hexdigest() != CPYTHON_SHA256:
        parser.error("CPython archive SHA-256 mismatch")
    missing = [name for name in REQUIRED if not (
        (args.site_packages / name / "__init__.py").is_file() or list(args.site_packages.glob(name + ".*.so"))
    )]
    if missing:
        parser.error("Missing Android dependency modules: " + ", ".join(missing))

    with TemporaryDirectory() as temporary:
        work = Path(temporary)
        with tarfile.open(args.cpython) as archive:
            archive.extractall(work, filter="data")
        prefix = work / "prefix"
        launcher = work / "libmooting-python.so"
        subprocess.run([
            str(args.clang.resolve()), "-O2", "-fPIE", "-pie", "-x", "c", "-", "-x", "none",
            str(prefix / "lib" / "libpython3.14.so"), "-o", str(launcher),
        ], input="extern int Py_BytesMain(int, char **);\n"
                 "int main(int argc, char **argv) { return Py_BytesMain(argc, argv); }\n",
            text=True, check=True)
        with ZipFile(args.output, "w") as out:
            files = {"jni/arm64-v8a/" + launcher.name: launcher}
            files.update({"jni/arm64-v8a/" + name: prefix / "lib" / name for name in LIBRARIES})
            for directory, intended in [(prefix / "lib" / STDLIB, "python/lib/" + STDLIB),
                                        (args.site_packages, "python/site-packages")]:
                for source in directory.rglob("*"):
                    if source.is_symlink():
                        raise ValueError("Unexpected symlink in runtime: " + str(source))
                    if source.is_file() and "__pycache__" not in source.parts and source.suffix != ".pyc":
                        files[intended + "/" + source.relative_to(directory).as_posix()] = source
            for name, source in sorted(files.items()):
                info = ZipInfo(name)
                info.compress_type = ZIP_DEFLATED
                with source.open("rb") as incoming, out.open(info, "w") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
    with args.output.open("rb") as stream:
        print(hashlib.file_digest(stream, "sha256").hexdigest())


if __name__ == "__main__":
    main()
