#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import tempfile
import unittest
from botocore.exceptions import ClientError
import sys

spec=importlib.util.spec_from_file_location('uploader',sys.argv.pop(1))
uploader=importlib.util.module_from_spec(spec)
spec.loader.exec_module(uploader)

class FakeS3:
    def __init__(self):
        self.objects={}
        self.puts=0
    def head_object(self,Bucket,Key):
        if Key not in self.objects:
            raise ClientError({'Error':{'Code':'404'}},'HeadObject')
        return {'ContentLength':len(self.objects[Key]),'ETag':'"fixture"'}
    def put_object(self,**kwargs):
        assert kwargs['CacheControl']=='public, max-age=31536000, immutable'
        self.objects[kwargs['Key']]=kwargs['Body'].read()
        self.puts+=1

class UploadTest(unittest.TestCase):
    def test_upload_existing_and_changed(self):
        with tempfile.TemporaryDirectory(prefix='slds-upload-test-') as directory:
            file=Path(directory)/'fixture.webp'
            file.write_bytes(b'upload-test-fixture')
            item=uploader.prepare(str(file),'categories')
            self.assertTrue(item['key'].startswith('categories/'+item['hash'][:2]+'/'+item['hash'][2:4]+'/'))
            client=FakeS3()
            self.assertEqual(uploader.upload(client,'fixture',item)[1],'uploaded')
            self.assertEqual(uploader.upload(client,'fixture',item)[1],'existing')
            self.assertEqual(client.puts,1)
            file.write_bytes(b'changed-test-fixture')
            with self.assertRaisesRegex(RuntimeError,'source changed'):
                uploader.upload(client,'fixture',item)

unittest.main()
