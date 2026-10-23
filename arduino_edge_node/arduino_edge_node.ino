
#include <math.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

struct GpsState {
  bool rmcValid = false;
  bool ggaValid = false;
  double latitude = 0;
  double longitude = 0;
  int satellites = 0;
  unsigned long lastRmcTime = 0;
  unsigned long lastGgaTime = 0;
  char date[11] = "";
  char time[9] = "";
};

bool isNmeaSentenceType(const char *identifier, const char *type) {
  return identifier != NULL && identifier[0] == '$' &&
         strlen(identifier) == 6 && memcmp(identifier + 3, type, 3) == 0;
}

bool parseNmeaInteger(const char *value, int *result) {
  if (value == NULL || value[0] == '\0') return false;
  for (const char *cursor = value; *cursor; ++cursor) {
    if (*cursor < '0' || *cursor > '9') return false;
  }

  *result = atoi(value);
  return true;
}

bool parseNmeaCoordinate(const char *value, char hemisphere,
                         bool isLatitude, double *result) {
  if (value == NULL || value[0] == '\0') return false;
  if (isLatitude ? (hemisphere != 'N' && hemisphere != 'S')
                 : (hemisphere != 'E' && hemisphere != 'W')) {
    return false;
  }

  char *end = NULL;
  const double raw = strtod(value, &end);
  if (end == value || *end != '\0' || !isfinite(raw) || raw < 0) return false;

  const double degrees = floor(raw / 100.0);
  const double minutes = raw - degrees * 100.0;
  const double maximum = isLatitude ? 90.0 : 180.0;
  if (minutes < 0 || minutes >= 60 || degrees > maximum ||
      (degrees == maximum && minutes != 0)) {
    return false;
  }

  double coordinate = degrees + minutes / 60.0;
  if (hemisphere == 'S' || hemisphere == 'W') coordinate = -coordinate;
  *result = coordinate;
  return true;
}

void updateNmeaDateTime(const char *rawTime, const char *rawDate,
                        GpsState *state) {
  if (rawTime != NULL && strlen(rawTime) >= 6 &&
      strspn(rawTime, "0123456789") >= 6) {
    snprintf(state->time, sizeof(state->time), "%.2s:%.2s:%.2s",
             rawTime, rawTime + 2, rawTime + 4);
  }

  if (rawDate != NULL && strlen(rawDate) >= 6 &&
      strspn(rawDate, "0123456789") == 6) {
    const int year = atoi(rawDate + 4);
    snprintf(state->date, sizeof(state->date), "%04d-%.2s-%.2s",
             year >= 80 ? 1900 + year : 2000 + year,
             rawDate + 2, rawDate);
  }
}

bool parseNmeaSentence(char *line, unsigned long now, GpsState *state) {
  if (line == NULL || state == NULL) return false;

  char *fields[16];
  size_t count = 1;
  fields[0] = line;
  for (char *cursor = line; *cursor; ++cursor) {
    if (*cursor == ',') {
      *cursor = '\0';
      if (count == sizeof(fields) / sizeof(fields[0])) return false;
      fields[count++] = cursor + 1;
    }
  }

  if (isNmeaSentenceType(fields[0], "GGA")) {
    if (count < 8) return false;

    int quality = 0;
    int satellites = 0;
    double latitude = 0;
    double longitude = 0;
    state->lastGgaTime = now;
    state->ggaValid =
        parseNmeaInteger(fields[6], &quality) && quality > 0 &&
        parseNmeaInteger(fields[7], &satellites) && satellites > 0 &&
        parseNmeaCoordinate(fields[2], fields[3][0], true, &latitude) &&
        parseNmeaCoordinate(fields[4], fields[5][0], false, &longitude);
    state->satellites = satellites;

    if (state->ggaValid) {
      state->latitude = latitude;
      state->longitude = longitude;
    }
    return true;
  }

  if (isNmeaSentenceType(fields[0], "RMC")) {
    if (count < 7) return false;

    state->lastRmcTime = now;
    state->rmcValid =
        fields[2][0] == 'A' &&
        parseNmeaCoordinate(fields[3], fields[4][0], true, &state->latitude) &&
        parseNmeaCoordinate(fields[5], fields[6][0], false, &state->longitude);
    if (state->rmcValid) {
      updateNmeaDateTime(count > 1 ? fields[1] : NULL,
                         count > 9 ? fields[9] : NULL, state);
    }
    return true;
  }

  return false;
}

bool hasGpsFix(const GpsState &state, unsigned long now,
               unsigned long staleAfterMs) {
  return state.rmcValid && state.ggaValid &&
         now - state.lastRmcTime <= staleAfterMs &&
         now - state.lastGgaTime <= staleAfterMs &&
         state.satellites > 0 && state.latitude >= -90 &&
         state.latitude <= 90 && state.longitude >= -180 &&
         state.longitude <= 180 &&
         (state.latitude != 0 || state.longitude != 0);
}

const float IMPACT_THRESHOLD_G = 0.60;
const unsigned long COOLDOWN_MS = 2000;
const unsigned long SENSOR_WARMUP_MS = 3000;

bool shouldEmitMotionEvent(float changeG, unsigned long now,
                           unsigned long bootTime,
                           unsigned long lastEventTime) {
  return now - bootTime >= SENSOR_WARMUP_MS &&
         changeG >= IMPACT_THRESHOLD_G &&
         now - lastEventTime >= COOLDOWN_MS;
}

int16_t decodeMpuAxisSample(uint8_t highByte, uint8_t lowByte) {
  const uint16_t raw = (static_cast<uint16_t>(highByte) << 8) | lowByte;
  const int32_t signedValue =
      raw < 0x8000 ? raw : static_cast<int32_t>(raw) - 0x10000L;
  return static_cast<int16_t>(signedValue);
}

#ifndef NEXUS_GPS_PARSER_TEST
#include <Wire.h>
#include <SoftwareSerial.h>

SoftwareSerial gpsSerial(4, 3);  // Arduino RX, TX

const uint8_t MPU_ADDR = 0x68;

const unsigned long GPS_STALE_MS = 5000;
const unsigned long GPS_STATUS_INTERVAL_MS = 5000;
const unsigned long GPS_LED_INTERVAL_MS = 500;

unsigned long bootTime = 0;
unsigned long lastEventTime = 0;
unsigned long lastNmeaTime = 0;
unsigned long lastGpsStatusTime = 0;
unsigned long lastGpsLedToggleTime = 0;
unsigned long eventNumber = 0;

float axG = 0, ayG = 0, azG = 0;
float previousAx = 0, previousAy = 0, previousAz = 0;

bool firstSample = true;
bool mpuReady = false;
bool mpuSampleHealthy = false;
bool nmeaReceived = false;
bool gpsLedOn = false;
GpsState gps;
char gpsLine[120];
uint8_t gpsLineIndex = 0;

bool writeMpuRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readMpuRegisters(uint8_t reg, uint8_t count, uint8_t *buffer) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);

  if (Wire.endTransmission(false) != 0) return false;

  uint8_t received = Wire.requestFrom(MPU_ADDR, count);
  if (received != count) {
    while (Wire.available()) Wire.read();
    return false;
  }

  for (uint8_t i = 0; i < count; i++) {
    buffer[i] = Wire.read();
  }
  return true;
}

bool initializeMpu() {
  uint8_t identity = 0;
  if (!readMpuRegisters(0x75, 1, &identity) || identity != 0x68) return false;

  if (!writeMpuRegister(0x6B, 0x00) ||
      !writeMpuRegister(0x1C, 0x00) ||
      !writeMpuRegister(0x1B, 0x00)) {
    return false;
  }

  delay(100);

  uint8_t powerManagement = 0;
  uint8_t accelerometerConfig = 0;
  uint8_t gyroscopeConfig = 0;
  return readMpuRegisters(0x6B, 1, &powerManagement) &&
         readMpuRegisters(0x1C, 1, &accelerometerConfig) &&
         readMpuRegisters(0x1B, 1, &gyroscopeConfig) &&
         (powerManagement & 0x40) == 0 &&
         (accelerometerConfig & 0x18) == 0 &&
         (gyroscopeConfig & 0x18) == 0;
}

bool readMpu() {
  uint8_t data[14];
  if (!readMpuRegisters(0x3B, 14, data)) return false;

  int16_t rawAx = decodeMpuAxisSample(data[0], data[1]);
  int16_t rawAy = decodeMpuAxisSample(data[2], data[3]);
  int16_t rawAz = decodeMpuAxisSample(data[4], data[5]);

  axG = rawAx / 16384.0f;
  ayG = rawAy / 16384.0f;
  azG = rawAz / 16384.0f;
  return true;
}

void readGps() {
  while (gpsSerial.available()) {
    char c = gpsSerial.read();

    if (c == '\r') continue;

    if (c == '\n') {
      gpsLine[gpsLineIndex] = '\0';
      if (gpsLineIndex > 6 && gpsLine[0] == '$') {
        nmeaReceived = true;
        lastNmeaTime = millis();
        parseNmeaSentence(gpsLine, lastNmeaTime, &gps);
      }
      gpsLineIndex = 0;
    } else if (gpsLineIndex < sizeof(gpsLine) - 1) {
      gpsLine[gpsLineIndex++] = c;
    } else {
      gpsLineIndex = 0;
    }
  }
}

void reportGpsStatus() {
  const unsigned long now = millis();
  if (now - lastGpsStatusTime < GPS_STATUS_INTERVAL_MS) return;
  lastGpsStatusTime = now;

  Serial.print("GPS_STATUS,");
  if (!nmeaReceived || now - lastNmeaTime > GPS_STALE_MS) {
    Serial.print("NO_DATA,0");
  } else if (hasGpsFix(gps, now, GPS_STALE_MS)) {
    Serial.print("FIX,");
    Serial.print(gps.satellites);
  } else {
    Serial.print("NO_FIX,");
    Serial.print(gps.satellites);
  }

  Serial.print(",");
  Serial.println(mpuReady && mpuSampleHealthy ? "READY" : "ERROR");
}

void updateGpsLed() {
  const unsigned long now = millis();
  if (!hasGpsFix(gps, now, GPS_STALE_MS)) {
    digitalWrite(LED_BUILTIN, LOW);
    gpsLedOn = false;
    return;
  }

  if (now - lastGpsLedToggleTime >= GPS_LED_INTERVAL_MS) {
    lastGpsLedToggleTime = now;
    gpsLedOn = !gpsLedOn;
    digitalWrite(LED_BUILTIN, gpsLedOn ? HIGH : LOW);
  }
}

void emitEvent() {
  eventNumber++;

  Serial.print("EVENT,");
  Serial.print(eventNumber);
  Serial.print(",");

  if (hasGpsFix(gps, millis(), GPS_STALE_MS)) {
    Serial.print(gps.latitude, 6);
    Serial.print(",");
    Serial.print(gps.longitude, 6);
  } else {
    Serial.print(",");
  }

  Serial.print(",");
  Serial.print(gps.satellites);
  Serial.print(",");
  Serial.print(gps.date);
  Serial.print(",");
  Serial.println(gps.time);
}

void setup() {
  Serial.begin(9600);
  gpsSerial.begin(9600);
  Wire.begin();
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

  bootTime = millis();

  Serial.println("ARHB MPU6050 INITIALIZING");
  mpuReady = initializeMpu();

  if (mpuReady) {
    Serial.println("MPU6050_READY");
  } else {
    Serial.println("ERROR: MPU6050 identity or configuration check failed");
  }

  Serial.println("ARHB_READY");
}

void loop() {
  readGps();
  updateGpsLed();
  reportGpsStatus();

  if (!mpuReady) {
    delay(100);
    return;
  }

  if (!readMpu()) {
    mpuSampleHealthy = false;
    delay(10);
    return;
  }
  mpuSampleHealthy = true;

  float dx = axG - previousAx;
  float dy = ayG - previousAy;
  float dz = azG - previousAz;
  float changeG = sqrt(dx * dx + dy * dy + dz * dz);

  previousAx = axG;
  previousAy = ayG;
  previousAz = azG;

  if (firstSample) {
    firstSample = false;
    delay(10);
    return;
  }

  // Hazard detection is independent of GPS reception.
  unsigned long now = millis();

  if (shouldEmitMotionEvent(changeG, now, bootTime, lastEventTime)) {
    lastEventTime = now;
    emitEvent();
  }

  delay(10);
}
#endif
