FROM us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2

COPY start-emulator-with-turn.sh /usr/local/bin/start-emulator-with-turn.sh

RUN command -v openssl >/dev/null 2>&1 || (apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*)
RUN chmod +x /usr/local/bin/start-emulator-with-turn.sh

ENTRYPOINT ["/usr/local/bin/start-emulator-with-turn.sh"]
