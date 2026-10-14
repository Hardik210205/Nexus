
#include <Wire.h>
#include <SoftwareSerial.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>

SoftwareSerial gpsSerial(4, 3);  // Arduino RX, TX

const uint8_t MPU_ADDR = 0x68;

const float IMPACT_THRESHOLD_G = 0.60;
const unsigned long COOLDOWN_MS = 2000;
const unsigned long SENSOR_WARMUP_MS = 3000;
const unsigned long GPS_STALE_MS = 5000;

unsigned long bootTime = 0;
unsigned long lastEventTime = 0;
unsigned long lastRmcTime = 0;
unsigned long lastGgaTime = 0;
unsigned long eventNumber = 0;

float axG = 0, ayG = 0, azG = 0;
float previousAx = 0, previousAy = 0, previousAz = 0;

bool firstSample = true;
bool mpuReady = false;
bool rmcValid = false;
bool ggaValid = false;

double gpsLatitude = 0;
double gpsLongitude = 0;
int gpsSatellites = 0;
char gpsDate[11] = "";
char gpsTime[9] = "";
char gpsLine[120];
uint8_t gpsLineIndex = 0;

void writeMpuRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
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
  Wire.beginTransmission(MPU_ADDR);
  if (Wire.endTransmission() != 0) return false;

  writeMpuRegister(0x6B, 0x00);  // Wake up
  writeMpuRegister(0x1C, 0x00);  // Accelerometer +/- 2g
  writeMpuRegister(0x1B, 0x00);  // Gyroscope +/- 250 dps

  delay(100);
  return true;
}

bool readMpu() {
  uint8_t data[14];
  if (!readMpuRegisters(0x3B, 14, data)) return false;

  int16_t rawAx = (int16_t)((data[0] << 8) | data[1]);
  int16_t rawAy = (int16_t)((data[2] << 8) | data[3]);
  int16_t rawAz = (int16_t)((data[4] << 8) | data[5]);

  axG = rawAx / 16384.0f;
  ayG = rawAy / 16384.0f;
  azG = rawAz / 16384.0f;
  return true;
}

double convertCoordinate(const char *value, char hemisphere) {
  double raw = atof(value);
  double degrees = floor(raw / 100.0);
  double minutes = raw - degrees * 100.0;
  double result = degrees + minutes / 60.0;

  if (hemisphere == 'S' || hemisphere == 'W') result = -result;
  return result;
}

void parseNmea(char *line) {
  char copy[120];
  strncpy(copy, line, sizeof(copy) - 1);
  copy[sizeof(copy) - 1] = '\0';

  char *fields[16];
  uint8_t count = 0;
  char *token = strtok(copy, ",");

  while (token && count < 16) {
    fields[count++] = token;
    token = strtok(NULL, ",");
  }

  if (count == 0) return;

  // GGA: fix quality, satellites and position.
  if (strstr(fields[0], "GGA") != NULL && count >= 10) {
    int quality = atoi(fields[6]);
    gpsSatellites = atoi(fields[7]);

    ggaValid = quality > 0 &&
               fields[2][0] != '\0' &&
               fields[4][0] != '\0';

    if (ggaValid) {
      gpsLatitude = convertCoordinate(fields[2], fields[3][0]);
      gpsLongitude = convertCoordinate(fields[4], fields[5][0]);
      lastGgaTime = millis();
    } else {
      lastGgaTime = millis();
    }
  }

  // RMC: validity, position, UTC time and date.
  if ((strncmp(fields[0], "$GPRMC", 6) == 0 ||
       strncmp(fields[0], "$GNRMC", 6) == 0) && count >= 10) {

    lastRmcTime = millis();
    rmcValid = fields[2][0] == 'A';

    if (!rmcValid) return;

    if (fields[3][0] && fields[5][0]) {
      gpsLatitude = convertCoordinate(fields[3], fields[4][0]);
      gpsLongitude = convertCoordinate(fields[5], fields[6][0]);
    }

    if (strlen(fields[1]) >= 6) {
      snprintf(gpsTime, sizeof(gpsTime), "%.2s:%.2s:%.2s",
               fields[1], fields[1] + 2, fields[1] + 4);
    }

    if (strlen(fields[9]) == 6 &&
        strspn(fields[9], "0123456789") == 6) {
      int year = atoi(fields[9] + 4);
      snprintf(gpsDate, sizeof(gpsDate), "%04d-%.2s-%.2s",
               year >= 80 ? 1900 + year : 2000 + year,
               fields[9] + 2, fields[9]);
    }
  }
}

void readGps() {
  while (gpsSerial.available()) {
    char c = gpsSerial.read();

    if (c == '\r') continue;

    if (c == '\n') {
      gpsLine[gpsLineIndex] = '\0';
      if (gpsLineIndex > 6) parseNmea(gpsLine);
      gpsLineIndex = 0;
    } else if (gpsLineIndex < sizeof(gpsLine) - 1) {
      gpsLine[gpsLineIndex++] = c;
    } else {
      gpsLineIndex = 0;
    }
  }
}

bool hasGpsFix() {
  unsigned long now = millis();

  return rmcValid && ggaValid &&
         now - lastRmcTime <= GPS_STALE_MS &&
         now - lastGgaTime <= GPS_STALE_MS &&
         gpsSatellites > 0 &&
         gpsLatitude >= -90 && gpsLatitude <= 90 &&
         gpsLongitude >= -180 && gpsLongitude <= 180 &&
         (gpsLatitude != 0 || gpsLongitude != 0);
}

void emitEvent() {
  eventNumber++;

  Serial.print("EVENT,");
  Serial.print(eventNumber);
  Serial.print(",");

  if (hasGpsFix()) {
    Serial.print(gpsLatitude, 6);
    Serial.print(",");
    Serial.print(gpsLongitude, 6);
  } else {
    Serial.print(",");
  }

  Serial.print(",");
  Serial.print(gpsSatellites);
  Serial.print(",");
  Serial.print(gpsDate);
  Serial.print(",");
  Serial.println(gpsTime);
}

void setup() {
  Serial.begin(9600);
  gpsSerial.begin(9600);
  Wire.begin();

  bootTime = millis();

  Serial.println("ARHB MPU6050 INITIALIZING");
  mpuReady = initializeMpu();

  if (mpuReady) {
    Serial.println("MPU6050_READY");
  } else {
    Serial.println("ERROR: MPU6050 not detected at 0x68");
  }

  Serial.println("ARHB_READY");
}

void loop() {
  readGps();

  if (!mpuReady) {
    delay(100);
    return;
  }

  if (!readMpu()) {
    delay(10);
    return;
  }

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

  if (now - bootTime >= SENSOR_WARMUP_MS &&
      changeG >= IMPACT_THRESHOLD_G &&
      now - lastEventTime >= COOLDOWN_MS) {
    lastEventTime = now;
    emitEvent();
  }

  delay(10);
}
