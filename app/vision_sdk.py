import base64
import cv2
import numpy as np
import os

class VisionAgent:

    def __init__(self):
        BASE_DIR = os.path.dirname(os.path.abspath(__file__))
        MODEL_PATH = os.path.join(BASE_DIR, "models")

        prototxt_path = os.path.join(MODEL_PATH, "deploy.prototxt")
        model_path = os.path.join(MODEL_PATH, "res10_300x300_ssd_iter_140000_fp16.caffemodel")

        self.net = cv2.dnn.readNetFromCaffe(prototxt_path, model_path)

    def detect(self, image_data: str):
        try:
            img_bytes = base64.b64decode(image_data.split(",")[1])
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            if frame is None:
                return self._empty()

            blob = cv2.dnn.blobFromImage(
                cv2.resize(frame, (300, 300)),
                1.0,
                (300, 300),
                (104.0, 177.0, 123.0)
            )

            self.net.setInput(blob)
            detections = self.net.forward()

            face_detected = False
            confidence = 0.0

            for i in range(detections.shape[2]):
                conf = detections[0, 0, i, 2]
                if conf > 0.5:
                    face_detected = True
                    confidence = float(conf)
                    break

            return {
                "face_detected": face_detected,
                "looking_forward": face_detected,
                "confidence": round(confidence, 2)
            }

        except Exception as e:
            print("Vision error:", e)
            return self._empty()

    def _empty(self):
        return {
            "face_detected": False,
            "looking_forward": False,
            "confidence": 0.0
        }