// macOS Vision supplies local text positions; no scan leaves this machine.
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSMutableArray *pages = [NSMutableArray array];
    for (int i = 1; i < argc; i++) {
      NSString *file = [NSString stringWithUTF8String:argv[i]];
      VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
      request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
      request.recognitionLanguages = @[@"en-US"];
      request.usesLanguageCorrection = NO;
      VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:[NSURL fileURLWithPath:file] options:@{}];
      NSError *error = nil;
      if (![handler performRequests:@[request] error:&error]) {
        fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
        return 1;
      }
      NSMutableArray *regions = [NSMutableArray array];
      for (VNRecognizedTextObservation *observation in request.results) {
        VNRecognizedText *text = [observation topCandidates:1].firstObject;
        if (!text) continue;
        CGRect b = observation.boundingBox;
        NSMutableArray *words = [NSMutableArray array];
        NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"\\S+" options:0 error:nil];
        for (NSTextCheckingResult *match in [pattern matchesInString:text.string options:0 range:NSMakeRange(0, text.string.length)]) {
          VNRectangleObservation *word = [text boundingBoxForRange:match.range error:nil];
          if (!word) continue;
          CGRect w = word.boundingBox;
          [words addObject:@{@"text":[text.string substringWithRange:match.range],
            @"bbox":@{@"x":@(w.origin.x), @"y":@(1 - w.origin.y - w.size.height), @"width":@(w.size.width), @"height":@(w.size.height)}}];
        }
        [regions addObject:@{@"text":text.string, @"confidence":@(text.confidence),
          @"words":words,
          @"bbox":@{@"x":@(b.origin.x), @"y":@(1 - b.origin.y - b.size.height), @"width":@(b.size.width), @"height":@(b.size.height)}}];
      }
      [pages addObject:@{@"imagePath":file, @"regions":regions}];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:pages options:NSJSONWritingPrettyPrinted error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
  }
  return 0;
}
