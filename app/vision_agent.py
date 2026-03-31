import base64
import cv2
import numpy as np
import os

# Load DNN model
MODEL_PATH = os.path.join("app", "models")

prototxt_path = os.path.join(MODEL_PATH, "deploy.prototxt")
model_path = os.path.join(MODEL_PATH, "res10_300x300_ssd_iter_140000_fp16.caffemodel")

net = cv2.dnn.readNetFromCaffe(prototxt_path, model_path)


def analyze_frame(image_data: str):
    try:
        img_bytes = base64.b64decode(image_data.split(",")[1])
        np_arr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if frame is None:
            return {
                "face_detected": False,
                "looking_forward": False,
                "confidence": 0.0
            }

        (h, w) = frame.shape[:2]

        blob = cv2.dnn.blobFromImage(
            cv2.resize(frame, (300, 300)),
            1.0,
            (300, 300),
            (104.0, 177.0, 123.0)
        )

        net.setInput(blob)
        detections = net.forward()

        face_detected = False
        confidence = 0.0

        for i in range(detections.shape[2]):
            conf = detections[0, 0, i, 2]

            if conf > 0.5:
                face_detected = True
                confidence = float(conf)
                break

        looking_forward = face_detected

        return {
            "face_detected": face_detected,
            "looking_forward": looking_forward,
            "confidence": round(confidence, 2)
        }

    except Exception as e:
        print("Vision error:", e)
        return {
            "face_detected": False,
            "looking_forward": False,
            "confidence": 0.0
        }