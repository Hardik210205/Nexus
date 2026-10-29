#define NEXUS_GPS_PARSER_TEST
#include "../arduino_edge_node.ino"

#include <assert.h>
#include <math.h>
#include <string.h>

static bool parse(const char *sentence, unsigned long now, GpsState *state) {
  char buffer[120];
  strncpy(buffer, sentence, sizeof(buffer) - 1);
  buffer[sizeof(buffer) - 1] = '\0';
  return parseNmeaSentence(buffer, now, state);
}

int main() {
  assert(decodeMpuAxisSample(0x00, 0x00) == 0);
  assert(decodeMpuAxisSample(0x7F, 0xFF) == 32767);
  assert(decodeMpuAxisSample(0x80, 0x00) == -32768);
  assert(decodeMpuAxisSample(0xFF, 0xFF) == -1);

  assert(!shouldEmitMotionEvent(2.50f, 2999, 0, 0));
  assert(!shouldEmitMotionEvent(2.49f, 3000, 0, 0));
  assert(shouldEmitMotionEvent(2.50f, 3000, 0, 0));
  assert(!shouldEmitMotionEvent(2.50f, 8999, 0, 4000));
  assert(shouldEmitMotionEvent(2.50f, 9000, 0, 4000));

  GpsState standard;
  assert(parse("$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47",
               1000, &standard));
  assert(parse("$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A",
               1200, &standard));
  assert(hasGpsFix(standard, 1200, 5000));
  assert(fabs(standard.latitude - 48.1173) < 0.00001);
  assert(fabs(standard.longitude - 11.5166667) < 0.00001);
  assert(strcmp(standard.date, "1994-03-23") == 0);
  assert(strcmp(standard.time, "12:35:19") == 0);

  GpsState alternateTalker;
  assert(parse("$GAGGA,123519,3450.000,S,05822.000,W,1,05",
               3000, &alternateTalker));
  assert(parse("$GARMC,123519,A,3450.000,S,05822.000,W,,,230394,,*00",
               3200, &alternateTalker));
  assert(hasGpsFix(alternateTalker, 3200, 5000));
  assert(fabs(alternateTalker.latitude + 34.8333333) < 0.00001);
  assert(fabs(alternateTalker.longitude + 58.3666667) < 0.00001);

  assert(!hasGpsFix(alternateTalker, 8201, 5000));
  assert(parse("$GNRMC,123520,V,3450.000,S,05822.000,W,,,230394,,*00",
               4000, &alternateTalker));
  assert(!hasGpsFix(alternateTalker, 4000, 5000));

  GpsState invalidCoordinates;
  assert(parse("$GNGGA,123519,9960.000,N,18100.000,E,1,08",
               1000, &invalidCoordinates));
  assert(!invalidCoordinates.ggaValid);

  return 0;
}
