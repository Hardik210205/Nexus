import argparse
import datetime as dt
import ipaddress
import os
import subprocess
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def create_certificate(
    subject_name,
    issuer_name,
    public_key,
    issuer_key,
    serial_number,
    not_before,
    not_after,
    extensions,
):
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject_name)
        .issuer_name(issuer_name)
        .public_key(public_key)
        .serial_number(serial_number)
        .not_valid_before(not_before)
        .not_valid_after(not_after)
    )
    for extension, critical in extensions:
        builder = builder.add_extension(extension, critical)
    return builder.sign(issuer_key, hashes.SHA256())


def write_private_key(path, private_key):
    path.write_bytes(private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    if os.name == "nt":
        user = subprocess.check_output(["whoami"], text=True).strip()
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:(F)"],
            check=True,
            capture_output=True,
            text=True,
        )
    else:
        path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(
        description="Create local-only development certificates for the Nexus NSP bridge."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / ".local" / "nsp-certs",
    )
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    filenames = (
        "ca-cert.pem",
        "ca-key.pem",
        "server-cert.pem",
        "server-key.pem",
        "device-cert.pem",
        "device-key.pem",
    )
    if any((output_dir / name).exists() for name in filenames):
        raise SystemExit(f"Refusing to overwrite existing certificate material in {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    now = dt.datetime.now(dt.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP384R1())
    ca_name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Nexus Local Development Only"),
        x509.NameAttribute(NameOID.COMMON_NAME, "Nexus NSP Development CA"),
    ])
    ca_certificate = create_certificate(
        ca_name,
        ca_name,
        ca_key.public_key(),
        ca_key,
        x509.random_serial_number(),
        now - dt.timedelta(minutes=5),
        now + dt.timedelta(days=3650),
        [
            (x509.BasicConstraints(ca=True, path_length=0), True),
            (x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=None,
                decipher_only=None,
            ), True),
            (x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), False),
        ],
    )
    (output_dir / "ca-cert.pem").write_bytes(ca_certificate.public_bytes(serialization.Encoding.PEM))
    write_private_key(output_dir / "ca-key.pem", ca_key)

    for role, common_name, uri, extended_usage in (
        ("server", "localhost", None, ExtendedKeyUsageOID.SERVER_AUTH),
        ("device", "arhb_uno_1", "spiffe://nexus.local/device/arhb_uno_1", ExtendedKeyUsageOID.CLIENT_AUTH),
    ):
        private_key = ec.generate_private_key(ec.SECP256R1())
        subject = x509.Name([
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Nexus Local Development Only"),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ])
        alternative_names = (
            [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            if role == "server"
            else [x509.UniformResourceIdentifier(uri)]
        )
        certificate = create_certificate(
            subject,
            ca_name,
            private_key.public_key(),
            ca_key,
            x509.random_serial_number(),
            now - dt.timedelta(minutes=5),
            now + dt.timedelta(days=397),
            [
                (x509.BasicConstraints(ca=False, path_length=None), True),
                (x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=False,
                    crl_sign=False,
                    encipher_only=None,
                    decipher_only=None,
                ), True),
                (x509.ExtendedKeyUsage([extended_usage]), False),
                (x509.SubjectAlternativeName(alternative_names), False),
                (x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), False),
            ],
        )
        (output_dir / f"{role}-cert.pem").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        write_private_key(output_dir / f"{role}-key.pem", private_key)

    print(f"Development-only certificates created in {output_dir}")
    print("The CA private key must remain local; these certificates are not for production.")


if __name__ == "__main__":
    main()
