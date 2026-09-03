#include <DHT.h> // Make sure to install the "DHT sensor library" by Adafruit in Arduino IDE

// DHT11 Configuration
#define DHTPIN A0       // Connecting DHT11 data pin to Analog Pin A0
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

// Ultrasonic HC-SR04 Configuration
#define TRIG_PIN 9
#define ECHO_PIN 10

void setup() {
  Serial.begin(9600);    // Start serial communication at 9600 baud
  dht.begin();           // Initialize DHT sensor
  
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
}

void loop() {
  // 1. Read Temperature
  float temperature = dht.readTemperature();
  
  // 2. Read Distance from Ultrasonic sensor
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  
  // Add a 30,000 microsecond timeout (~5 meters max). This prevents crazy 2000+ cm readings!
  long duration = pulseIn(ECHO_PIN, HIGH, 30000); 
  
  float distance = duration * 0.034 / 2; 

  // Filter out noise or out-of-range HC-SR04 readings
  if (distance <= 0 || distance > 400) {
    distance = -1.0; // Use -1 to indicate "Out of Range"
  }
  
  // Handle failed reads from DHT
  if (isnan(temperature)) {
    temperature = -999.0; // Error value indicator
  }
  
  // 3. Output Data as a structured JSON string over Serial
  // This will be picked up by our laptop Bridge later!
  Serial.print("{\"deviceId\":\"uno_node_1\", ");
  Serial.print("\"type\":\"telemetry\", ");
  Serial.print("\"temperature\":");
  Serial.print(temperature);
  Serial.print(", \"distance\":");
  Serial.print(distance);
  Serial.println("}");
  
  // Wait 2 seconds before the next reading
  delay(2000); 
}

